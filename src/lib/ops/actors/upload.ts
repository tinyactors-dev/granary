/**
 * `upload/<runId>.<destinationId>` — one sealed artifact to one destination
 * (ADR 0082, 0095, 0096, 0098, 0111). Virtual: rebuilt from its `uploads` row.
 *
 *   restore ──(row state)──▶ idle | making-room | committing | verifying | retry-wait
 *   idle ──upload.start──▶ making-room
 *   making-room (entry: retention.make-room → retention/<dest>; room timeout)
 *     ──retention.room-made | upload.room-timeout──▶ uploading
 *   uploading (entry: store.put-artifact via object-store; seals while streaming)
 *     ──store.artifact-stored──▶ committing
 *   committing (entry: store.put-manifest, If-None-Match: * — the commit marker)
 *     ──store.manifest-committed──▶ verifying
 *   verifying (entry: store.verify) ──store.verified──▶ done
 *   store.error [retryable, attempts < max] ──▶ retry-wait ──upload.retry──▶ uploading | committing
 *   store.error ──▶ failed
 *   done   → upload.done → backup-run/<runId> (local-dir: retention.tick to keep one copy)
 *   failed → upload.record-failed via backup-ledger; upload.failed → backup-run/<runId>
 */
import { literal, statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, OPS_IO, SEND_ID, opsTargetUri, retentionAddress, runAddress } from '../schemas/events';
import { manifestKeyOf } from '../schemas/destinations';
import type { BackupManifest } from '../schemas/manifest';
import type { StoreError } from '../schemas/runs';
import type { RawSnapshot } from '../backups/repo';

export interface UploadData {
	runId: string;
	destinationId: string;
	database: string;
	local: boolean;
	phase: string;
	snapshot: RawSnapshot | null;
	artifactKey: string | null;
	manifest: BackupManifest | null;
	attempts: number;
	maxAttempts: number;
	retryBaseMs: number;
	makeRoomTimeoutMs: number;
	nextAttemptAt: number | null;
	lastError: StoreError | null;
	/** Estimated sealed size, for make-room (last sealed × 1.1, else raw). */
	estimatedBytes: number;
}

export const UPLOAD_REVISION = 'v1';
export const ROOM_SEND_ID = 'room';
export const MAX_RETRY_DELAY_MS = 30 * 60_000;
export const UPLOAD_STATES = {
	restore: 'restore',
	idle: 'idle',
	makingRoom: 'making-room',
	uploading: 'uploading',
	committing: 'committing',
	verifying: 'verifying',
	retryWait: 'retry-wait',
	done: 'done',
	failed: 'failed'
} as const;

type Ctx = EvaluationContext<UploadData>;
const ev = <T>(c: Ctx) => c.event!.data as T;

const canRetry = (c: Ctx) => {
	const e = ev<{ error: StoreError }>(c).error;
	return e.retryable && c.data.attempts < c.data.maxAttempts;
};
const retryDelay = ({ data }: Ctx) => {
	if (data.nextAttemptAt !== null) return Math.max(0, data.nextAttemptAt - Date.now());
	return Math.min(MAX_RETRY_DELAY_MS, data.retryBaseMs * 2 ** Math.max(0, data.attempts - 1));
};
const runUri = ({ data }: Ctx) => opsTargetUri(runAddress(data.runId));
const retentionUri = ({ data }: Ctx) => opsTargetUri(retentionAddress(data.destinationId));

export function uploadChart(): DefinitionBuilder<UploadData> {
	const S = UPLOAD_STATES;
	/** store.error handling shared by uploading/committing/verifying. */
	const onStoreError = (s: any) =>
		s
			.on('store.error', (t: any) =>
				t
					.when(canRetry)
					.target(S.retryWait)
					.assign('lastError', (c: Ctx) => ev<{ error: StoreError }>(c).error)
					// Integrity failures (manifest withdrawn / object incomplete) restart from a full upload.
					.assign('manifest', (c: Ctx) => (ev<{ error: StoreError }>(c).error.code === 'integrity' ? null : c.data.manifest))
					.assign('nextAttemptAt', (c: Ctx) => {
						const e = ev<{ error: StoreError }>(c).error;
						const delay = e.retryAfterMs ?? Math.min(MAX_RETRY_DELAY_MS, c.data.retryBaseMs * 2 ** Math.max(0, c.data.attempts - 1));
						return Date.now() + delay;
					})
			)
			.on('store.error', (t: any) => t.target(S.failed).assign('lastError', (c: Ctx) => ev<{ error: StoreError }>(c).error))
			.on('error.communication', (t: any) =>
				t.target(S.failed).assign('lastError', literal({ code: 'other', retryable: false, status: null, providerCode: null, message: 'object-store processor unavailable', retryAfterMs: null }))
			);
	return (
		statechart<UploadData>({ family: OPS_FAMILY.upload, revision: UPLOAD_REVISION, name: 'upload' })
			.data('runId', 'run')
			.data('destinationId', 'dest')
			.data('database', 'db')
			.data('local', false)
			.data('phase', 'pending')
			.data('snapshot', null)
			.data('artifactKey', null)
			.data('manifest', null)
			.data('attempts', 0)
			.data('maxAttempts', 6)
			.data('retryBaseMs', 30_000)
			.data('makeRoomTimeoutMs', 600_000)
			.data('nextAttemptAt', null)
			.data('lastError', null)
			.data('estimatedBytes', 0)
			.initial(S.restore)
			.state(S.restore, (s) =>
				s
					.always((t) => t.when(({ data }: Ctx) => data.phase === 'retry-wait' && data.snapshot !== null).target(S.retryWait))
					.always((t) => t.when(({ data }: Ctx) => data.phase === 'verifying' && data.manifest !== null).target(S.verifying))
					.always((t) => t.when(({ data }: Ctx) => data.phase === 'committing' && data.manifest !== null).target(S.committing))
					.always((t) => t.when(({ data }: Ctx) => (data.phase === 'making-room' || data.phase === 'uploading') && data.snapshot !== null).target(S.makingRoom))
					.always((t) => t.target(S.idle))
			)
			.state(S.idle, (s) =>
				s.on('upload.start', (t) =>
					t
						.target(S.makingRoom)
						.assign('snapshot', (c: Ctx) => ev<{ snapshot: RawSnapshot }>(c).snapshot)
						.assign('artifactKey', (c: Ctx) => ev<{ artifactKey?: string }>(c).artifactKey ?? c.data.artifactKey)
						.assign('estimatedBytes', (c: Ctx) => c.data.estimatedBytes || ev<{ snapshot: RawSnapshot }>(c).snapshot.rawBytes)
				)
			)
			.state(S.makingRoom, (s) =>
				s
					.entry((a) =>
						a
							.send('retention.make-room', (b) =>
								b.to(retentionUri).data(({ data }: Ctx) => ({ destinationId: data.destinationId, database: data.database, estimatedBytes: data.estimatedBytes, runId: data.runId }))
							)
							.send('upload.room-timeout', (b) => b.id(ROOM_SEND_ID).after(({ data }: Ctx) => data.makeRoomTimeoutMs))
					)
					.exit((a) => a.cancel(ROOM_SEND_ID))
					.on('retention.room-made', (t) => t.target(S.uploading))
					.on('upload.room-timeout', (t) => t.target(S.uploading))
					.on('upload.start')
			)
			.state(S.uploading, (s) =>
				onStoreError(
					s
						.entry((a) =>
							a
								.assign('attempts', ({ data }: Ctx) => data.attempts + 1)
								.assign('nextAttemptAt', literal(null))
								.send('store.put-artifact', (b) =>
									b.via(OPS_IO.objectStore).data(({ data }: Ctx) => ({ runId: data.runId, destinationId: data.destinationId, snapshot: data.snapshot, artifactKey: data.artifactKey }))
								)
						)
						.on('store.artifact-stored', (t) => t.target(S.committing).assign('manifest', (c: Ctx) => ev<{ manifest: BackupManifest }>(c).manifest))
						.on('upload.start')
				)
			)
			.state(S.committing, (s) =>
				onStoreError(
					s
						.entry((a) =>
							a
								.assign('nextAttemptAt', literal(null))
								.send('store.put-manifest', (b) =>
									b.via(OPS_IO.objectStore).data(({ data }: Ctx) => ({ runId: data.runId, destinationId: data.destinationId, manifest: data.manifest }))
								)
						)
						.on('store.manifest-committed', (t) => t.target(S.verifying))
						.on('upload.start')
				)
			)
			.state(S.verifying, (s) =>
				onStoreError(
					s
						.entry((a) =>
							a.send('store.verify', (b) =>
								b.via(OPS_IO.objectStore).data(({ data }: Ctx) => ({ runId: data.runId, destinationId: data.destinationId, manifest: data.manifest }))
							)
						)
						.on('store.verified', (t) => t.target(S.done))
						.on('upload.start')
				)
			)
			.state(S.retryWait, (s) =>
				s
					.entry((a) =>
						a
							.send('upload.record-retry', (b) =>
								b.via(OPS_IO.ledger).data(({ data }: Ctx) => ({
									runId: data.runId,
									destinationId: data.destinationId,
									attempts: data.attempts,
									nextAttemptAt: data.nextAttemptAt ?? Date.now(),
									lastError: data.lastError
								}))
							)
							.send('upload.retry', (b) => b.id(SEND_ID.retry).after(retryDelay))
					)
					.exit((a) => a.cancel(SEND_ID.retry))
					.on('upload.retry', (t) => t.when(({ data }: Ctx) => data.manifest !== null).target(S.committing).assign('attempts', ({ data }: Ctx) => data.attempts + 1))
					.on('upload.retry', (t) => t.target(S.uploading))
					.on('upload.start')
			)
			.final(S.done, (s) =>
				s
					.entry((a) =>
						a
							.send('upload.done', (b) =>
								b.to(runUri).data(({ data }: Ctx) => ({
									runId: data.runId,
									destinationId: data.destinationId,
									manifestKey: manifestKeyOf(data.manifest!.artifactKey),
									sealedBytes: data.manifest!.sealed.bytes
								}))
							)
							.choose(({ data }: Ctx) => data.local, (x) => x.send('retention.tick', (b) => b.to(retentionUri)))
					)
					.doneData((d) => d.content(({ data }: Ctx) => ({ runId: data.runId, destinationId: data.destinationId, state: 'done' })))
			)
			.final(S.failed, (s) =>
				s
					.entry((a) =>
						a
							.send('upload.record-failed', (b) =>
								b.via(OPS_IO.ledger).data(({ data }: Ctx) => ({ runId: data.runId, destinationId: data.destinationId, attempts: data.attempts, lastError: data.lastError }))
							)
							.send('upload.failed', (b) =>
								b.to(runUri).data(({ data }: Ctx) => ({ runId: data.runId, destinationId: data.destinationId, attempts: data.attempts, lastError: data.lastError }))
							)
					)
					.doneData((d) => d.content(({ data }: Ctx) => ({ runId: data.runId, destinationId: data.destinationId, state: 'failed' })))
			)
	);
}
