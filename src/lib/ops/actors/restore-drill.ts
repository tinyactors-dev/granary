/**
 * `restore-drill/<destinationId>` — weekly proof that backups restore
 * (ADR 0082, 0091, 0111). For each database backed up to the destination:
 * download the newest committed backup, decrypt, verify sha256s, then
 * integrity_check + row counts against the manifest in the Worker.
 *
 *   armed (entry: drill.tick after lastDrillAt + interval − now, id=tick)
 *     ──drill.tick | drill.run-now──▶ fetching (queue = databases)
 *   fetching (entry: drill.fetch via object-store)
 *     ──drill.fetched──▶ checking
 *     ──drill.checked (fetch failed)──▶ next
 *   checking (entry: drill.check via snapshot) ──drill.checked──▶ next
 *   next: more databases → fetching, else armed (lastDrillAt = now)
 */
import { literal, statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, OPS_IO, SEND_ID } from '../schemas/events';
import type { BackupManifest } from '../schemas/manifest';

export interface RestoreDrillData {
	destinationId: string;
	intervalMs: number;
	lastDrillAt: number | null;
	databases: string[];
	queue: string[];
	drillId: string | null;
	database: string | null;
	localPath: string | null;
	runId: string | null;
	manifest: BackupManifest | null;
	requestedBy: string | null;
	lastResult: string | null;
}

export const RESTORE_DRILL_REVISION = 'v1';
export const RESTORE_DRILL_STATES = { armed: 'armed', fetching: 'fetching', checking: 'checking' } as const;

type Ctx = EvaluationContext<RestoreDrillData>;
const ev = <T>(c: Ctx) => c.event!.data as T;

const newDrillId = () => `drill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function restoreDrillChart(): DefinitionBuilder<RestoreDrillData> {
	const S = RESTORE_DRILL_STATES;
	const start = (t: any) =>
		t
			.when(({ data }: Ctx) => data.databases.length > 0)
			.target(S.fetching)
			.assign('queue', ({ data }: Ctx) => data.databases.slice(1))
			.assign('database', ({ data }: Ctx) => data.databases[0]!);
	return statechart<RestoreDrillData>({ family: OPS_FAMILY.drill, revision: RESTORE_DRILL_REVISION, name: 'restore-drill' })
		.data('destinationId', 'dest')
		.data('intervalMs', 7 * 86_400_000)
		.data('lastDrillAt', null)
		.data('databases', [])
		.data('queue', [])
		.data('drillId', null)
		.data('database', null)
		.data('localPath', null)
		.data('runId', null)
		.data('manifest', null)
		.data('requestedBy', null)
		.data('lastResult', null)
		.initial(S.armed)
		.state(S.armed, (s) =>
			s
				.entry((a) =>
					a.send('drill.tick', (b) => b.id(SEND_ID.tick).after(({ data }: Ctx) => Math.max(0, (data.lastDrillAt ?? Date.now()) + data.intervalMs - Date.now())))
				)
				.exit((a) => a.cancel(SEND_ID.tick))
				.on('drill.tick', start)
				.on('drill.tick', (t) => t.target(S.armed).assign('lastDrillAt', () => Date.now()))
				.on('drill.run-now', (t) => start(t).assign('requestedBy', (c: Ctx) => ev<{ requestedBy: string }>(c).requestedBy))
				.on('config.updated')
		)
		.state(S.fetching, (s) =>
			s
				.entry((a) =>
					a
						.assign('drillId', newDrillId)
						.assign('manifest', literal(null))
						.send('drill.fetch', (b) =>
							b.via(OPS_IO.objectStore).data(({ data }: Ctx) => ({ drillId: data.drillId, destinationId: data.destinationId, database: data.database }))
						)
				)
				.on('drill.fetched', (t) =>
					t
						.target(S.checking)
						.assign('localPath', (c: Ctx) => ev<{ localPath: string }>(c).localPath)
						.assign('runId', (c: Ctx) => ev<{ runId: string }>(c).runId)
						.assign('manifest', (c: Ctx) => ev<{ manifest: BackupManifest }>(c).manifest)
				)
				.on('drill.checked', (t) => t.assign('lastResult', (c: Ctx) => ev<{ result: string }>(c).result).raise('drill.next'))
				.on('error.communication', (t) => t.assign('lastResult', literal('download-failed')).raise('drill.next'))
				.on('drill.next', (t) =>
					t
						.when(({ data }: Ctx) => data.queue.length > 0)
						.target(S.fetching)
						.assign('database', ({ data }: Ctx) => data.queue[0]!)
						.assign('queue', ({ data }: Ctx) => data.queue.slice(1))
				)
				.on('drill.next', (t) => t.target(S.armed).assign('lastDrillAt', () => Date.now()))
				.on('drill.run-now')
				.on('drill.tick')
		)
		.state(S.checking, (s) =>
			s
				.entry((a) =>
					a.send('drill.check', (b) =>
						b.via(OPS_IO.snapshot).data(({ data }: Ctx) => ({
							drillId: data.drillId,
							destinationId: data.destinationId,
							runId: data.runId,
							localPath: data.localPath,
							manifest: data.manifest
						}))
					)
				)
				.on('drill.checked', (t) =>
					t
						.when(({ data }: Ctx) => data.queue.length > 0)
						.target(S.fetching)
						.assign('lastResult', (c: Ctx) => ev<{ result: string }>(c).result)
						.assign('database', ({ data }: Ctx) => data.queue[0]!)
						.assign('queue', ({ data }: Ctx) => data.queue.slice(1))
				)
				.on('drill.checked', (t) => t.target(S.armed).assign('lastResult', (c: Ctx) => ev<{ result: string }>(c).result).assign('lastDrillAt', () => Date.now()))
				.on('error.communication', (t) => t.target(S.armed).assign('lastResult', literal('integrity-failed')).assign('lastDrillAt', () => Date.now()))
				.on('drill.run-now')
				.on('drill.tick')
		);
}
