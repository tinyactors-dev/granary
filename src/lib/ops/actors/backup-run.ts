/**
 * `backup-run/<runId>` — one snapshot of one database, uploaded to each
 * destination of its plan (ADR 0082, 0098, 0111). Virtual: the loader
 * rebuilds it from `backup_runs` + `uploads` rows, so a crash at any step
 * resumes where the rows say.
 *
 *   restore ──(row state)──▶ idle | snapshotting | uploading
 *   idle ──run.start──▶ snapshotting
 *   snapshotting (entry: snapshot.request via snapshot)
 *     ──snapshot.ready──▶ uploading
 *     ──snapshot.failed [disk-insufficient]──▶ finalizing (postponed)
 *     ──snapshot.failed [attempt < 3]──▶ snapshotting
 *     ──snapshot.failed──▶ finalizing (failed)
 *   uploading (entry: run.uploads via backup-ledger → upload.start per destination)
 *     upload.done / upload.failed → tally; all terminal → finalizing
 *   finalizing (entry: run.finalize via backup-ledger) → succeeded | partial | failed | postponed
 */
import { literal, statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, OPS_IO } from '../schemas/events';
import type { RawSnapshot } from '../backups/repo';

export type RunOutcome = 'succeeded' | 'partial' | 'failed' | 'postponed';

export interface BackupRunData {
	runId: string;
	planId: string;
	database: string;
	dbPath: string;
	spoolDir: string;
	destinationIds: string[];
	trigger: string;
	/** Row state at load time (restore routing). */
	phase: string;
	snapshot: RawSnapshot | null;
	/** destinationId → 'done' | 'failed' once terminal. */
	uploads: Record<string, 'done' | 'failed'>;
	attempt: number;
	sealedBytes: number | null;
	outcome: RunOutcome | null;
	error: string | null;
}

export const BACKUP_RUN_REVISION = 'v1';
export const MAX_SNAPSHOT_ATTEMPTS = 3;
export const BACKUP_RUN_STATES = {
	restore: 'restore',
	idle: 'idle',
	snapshotting: 'snapshotting',
	uploading: 'uploading',
	finalizing: 'finalizing',
	succeeded: 'succeeded',
	partial: 'partial',
	failed: 'failed',
	postponed: 'postponed'
} as const;

type Ctx = EvaluationContext<BackupRunData>;
const ev = <T>(c: Ctx) => c.event!.data as T;

const allTerminal = ({ data }: Ctx) => data.destinationIds.every((d) => data.uploads[d]);
const tallyOutcome = ({ data }: Ctx): RunOutcome => {
	const states = data.destinationIds.map((d) => data.uploads[d]);
	if (!states.length) return 'failed';
	if (states.every((s) => s === 'done')) return 'succeeded';
	return states.some((s) => s === 'done') ? 'partial' : 'failed';
};

export function backupRunChart(): DefinitionBuilder<BackupRunData> {
	const S = BACKUP_RUN_STATES;
	const finalState = (name: RunOutcome) => (s: any) =>
		s.doneData((d: any) => d.content(({ data }: Ctx) => ({ runId: data.runId, state: name, sealedBytes: data.sealedBytes })));
	return (
		statechart<BackupRunData>({ family: OPS_FAMILY.run, revision: BACKUP_RUN_REVISION, name: 'backup-run' })
			.data('runId', 'run')
			.data('planId', 'plan')
			.data('database', 'db')
			.data('dbPath', '')
			.data('spoolDir', '')
			.data('destinationIds', [])
			.data('trigger', 'schedule')
			.data('phase', 'pending')
			.data('snapshot', null)
			.data('uploads', {})
			.data('attempt', 0)
			.data('sealedBytes', null)
			.data('outcome', null)
			.data('error', null)
			.initial(S.restore)
			.state(S.restore, (s) =>
				s
					.always((t) => t.when(({ data }: Ctx) => data.phase === 'snapshotting').target(S.snapshotting))
					.always((t) => t.when(({ data }: Ctx) => data.phase === 'uploading' && data.snapshot !== null).target(S.uploading))
					.always((t) => t.when(({ data }: Ctx) => data.phase === 'uploading').target(S.snapshotting))
					.always((t) => t.target(S.idle))
			)
			.state(S.idle, (s) =>
				s.on('run.start', (t) =>
					t
						.target(S.snapshotting)
						.assign('destinationIds', (c: Ctx) => ev<{ destinationIds: string[] }>(c).destinationIds)
						.assign('trigger', (c: Ctx) => ev<{ trigger: string }>(c).trigger)
				)
			)
			.state(S.snapshotting, (s) =>
				s
					.entry((a) =>
						a
							.assign('attempt', ({ data }: Ctx) => data.attempt + 1)
							.send('snapshot.request', (b) =>
								b.via(OPS_IO.snapshot).data(({ data }: Ctx) => ({ runId: data.runId, database: data.database, dbPath: data.dbPath, spoolDir: data.spoolDir }))
							)
					)
					.on('snapshot.ready', (t) => t.target(S.uploading).assign('snapshot', (c: Ctx) => ev<RawSnapshot>(c)))
					.on('snapshot.failed', (t) =>
						t
							.when((c: Ctx) => ev<{ reason: string }>(c).reason === 'disk-insufficient')
							.target(S.finalizing)
							.assign('outcome', literal('postponed'))
							.assign('error', (c: Ctx) => ev<{ detail: string }>(c).detail)
					)
					.on('snapshot.failed', (t) =>
						t
							.when(({ data }: Ctx) => data.attempt < MAX_SNAPSHOT_ATTEMPTS)
							.target(S.snapshotting)
							.assign('error', (c: Ctx) => ev<{ detail: string }>(c).detail)
					)
					.on('snapshot.failed', (t) =>
						t.target(S.finalizing).assign('outcome', literal('failed')).assign('error', (c: Ctx) => `snapshot failed: ${ev<{ detail: string }>(c).detail}`)
					)
					.on('error.communication', (t) => t.target(S.finalizing).assign('outcome', literal('failed')).assign('error', literal('snapshot processor unavailable')))
			)
			.state(S.uploading, (s) =>
				s
					.entry((a) =>
						a.send('run.uploads', (b) =>
							b.via(OPS_IO.ledger).data(({ data }: Ctx) => ({ runId: data.runId, destinationIds: data.destinationIds, snapshot: data.snapshot }))
						)
					)
					.always((t) => t.when(allTerminal).target(S.finalizing).assign('outcome', tallyOutcome))
					.on('upload.done', (t) =>
						t
							.assign('uploads', (c: Ctx) => ({ ...c.data.uploads, [ev<{ destinationId: string }>(c).destinationId]: 'done' }))
							.assign('sealedBytes', (c: Ctx) => Math.max(c.data.sealedBytes ?? 0, ev<{ sealedBytes: number }>(c).sealedBytes))
					)
					.on('upload.failed', (t) =>
						t
							.assign('uploads', (c: Ctx) => ({ ...c.data.uploads, [ev<{ destinationId: string }>(c).destinationId]: 'failed' }))
							.assign('error', (c: Ctx) => {
								const d = ev<{ destinationId: string; lastError: { code: string; message: string } }>(c);
								return `${d.destinationId}: ${d.lastError.code} — ${d.lastError.message}`;
							})
					)
			)
			.state(S.finalizing, (s) =>
				s
					.entry((a) =>
						a.send('run.finalize', (b) =>
							b.via(OPS_IO.ledger).data(({ data }: Ctx) => ({
								runId: data.runId,
								planId: data.planId,
								state: data.outcome ?? 'failed',
								sealedBytes: data.sealedBytes,
								error: data.outcome === 'succeeded' ? null : data.error
							}))
						)
					)
					.always((t) => t.when(({ data }: Ctx) => data.outcome === 'succeeded').target(S.succeeded))
					.always((t) => t.when(({ data }: Ctx) => data.outcome === 'partial').target(S.partial))
					.always((t) => t.when(({ data }: Ctx) => data.outcome === 'postponed').target(S.postponed))
					.always((t) => t.target(S.failed))
			)
			.final(S.succeeded, finalState('succeeded'))
			.final(S.partial, finalState('partial'))
			.final(S.failed, finalState('failed'))
			.final(S.postponed, finalState('postponed'))
	);
}
