/**
 * `retention/<destinationId>` — bounded retention of one destination
 * (ADR 0082, 0096, 0111). Runs daily and before each upload ("make room
 * before writing"); passes are serialised, waiting uploads are queued.
 *
 *   idle (entry: retention.tick after dailyMs, id=tick)
 *     ──retention.tick──▶ pruning (daily)
 *     ──retention.make-room──▶ pruning (make-room for one upload)
 *   pruning (entry: retention.pass via object-store; list → plan → delete until converged)
 *     retention.make-room → queued
 *     ──retention.pass-done──▶ reply retention.room-made to the upload; next queued pass | idle
 */
import { literal, statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, OPS_IO, SEND_ID, opsTargetUri, uploadAddress } from '../schemas/events';

interface Waiter {
	runId: string;
	database: string;
	estimatedBytes: number;
}

export interface RetentionData {
	destinationId: string;
	dailyMs: number;
	mode: 'daily' | 'make-room' | 'after-upload';
	current: Waiter | null;
	waiters: Waiter[];
	lastPass: { at: number; deleted: number; converged: boolean; floorExceedsCap: boolean } | null;
}

export const RETENTION_REVISION = 'v1';
export const RETENTION_STATES = { idle: 'idle', pruning: 'pruning' } as const;

type Ctx = EvaluationContext<RetentionData>;
const ev = <T>(c: Ctx) => c.event!.data as T;

export function retentionChart(): DefinitionBuilder<RetentionData> {
	const S = RETENTION_STATES;
	return statechart<RetentionData>({ family: OPS_FAMILY.retention, revision: RETENTION_REVISION, name: 'retention' })
		.data('destinationId', 'dest')
		.data('dailyMs', 86_400_000)
		.data('mode', 'daily')
		.data('current', null)
		.data('waiters', [])
		.data('lastPass', null)
		.initial(S.idle)
		.state(S.idle, (s) =>
			s
				.entry((a) => a.send('retention.tick', (b) => b.id(SEND_ID.tick).after(({ data }: Ctx) => data.dailyMs)))
				.exit((a) => a.cancel(SEND_ID.tick))
				.on('retention.tick', (t) => t.target(S.pruning).assign('mode', literal('daily')).assign('current', literal(null)))
				.on('retention.make-room', (t) => t.target(S.pruning).assign('mode', literal('make-room')).assign('current', (c: Ctx) => ev<Waiter>(c)))
				.on('config.updated')
		)
		.state(S.pruning, (s) =>
			s
				.entry((a) =>
					a.send('retention.pass', (b) =>
						b.via(OPS_IO.objectStore).data(({ data }: Ctx) => ({
							destinationId: data.destinationId,
							mode: data.mode,
							database: data.current?.database ?? null,
							estimatedBytes: data.current?.estimatedBytes ?? 0,
							runId: data.current?.runId ?? null
						}))
					)
				)
				.on('retention.make-room', (t) => t.assign('waiters', (c: Ctx) => [...c.data.waiters, ev<Waiter>(c)]))
				.on('retention.tick')
				.on('config.updated')
				.on('retention.pass-done', (t) =>
					t
						.assign('lastPass', (c: Ctx) => {
							const d = ev<{ deleted: number; converged: boolean; floorExceedsCap?: boolean }>(c);
							return { at: Date.now(), deleted: d.deleted, converged: d.converged, floorExceedsCap: !!d.floorExceedsCap };
						})
						.choose(
							({ data }: Ctx) => data.current !== null,
							(x) =>
								x.send('retention.room-made', (b) =>
									b
										.to(({ data }: Ctx) => opsTargetUri(uploadAddress(data.current!.runId, data.destinationId)))
										.data((c: Ctx) => ({ runId: c.data.current!.runId, deletedObjects: ev<{ deleted: number }>(c).deleted, freedBytes: ev<{ freedBytes: number }>(c).freedBytes }))
								)
						)
						.raise('retention.next')
				)
				.on('error.communication', (t) =>
					t
						.choose(
							({ data }: Ctx) => data.current !== null,
							(x) =>
								x.send('retention.room-made', (b) =>
									b.to(({ data }: Ctx) => opsTargetUri(uploadAddress(data.current!.runId, data.destinationId))).data(({ data }: Ctx) => ({ runId: data.current!.runId, deletedObjects: 0, freedBytes: 0 }))
								)
						)
						.raise('retention.next')
				)
				// Internal: continue with the next queued upload, or rest.
				.on('retention.next', (t) =>
					t
						.when(({ data }: Ctx) => data.waiters.length > 0)
						.target(S.pruning)
						.assign('mode', literal('make-room'))
						.assign('current', ({ data }: Ctx) => data.waiters[0]!)
						.assign('waiters', ({ data }: Ctx) => data.waiters.slice(1))
				)
				.on('retention.next', (t) => t.target(S.idle).assign('current', literal(null)))
		);
}
