/**
 * `backup-plan/<planId>` — the schedule of one plan (ADR 0082, 0098, 0111).
 * Spawned by the ledger's reconcile with a binding derived from ops.sqlite
 * (last started run, effective interval), so restarts re-arm correctly and
 * missed windows collapse into one catch-up run.
 *
 *   restore ──[enabled]──▶ armed      ──[disabled]──▶ paused
 *   armed (entry: plan.tick after lastStartedAt + interval − now, id=tick)
 *     ──plan.tick──▶ dispatching (trigger schedule | catch-up)
 *     ──plan.run-now──▶ dispatching (manual)
 *     ──plan.interval──▶ armed (re-armed with the new interval)
 *   dispatching (entry: plan.dispatch via backup-ledger)
 *     ──plan.dispatched──▶ armed | paused
 *   paused ──plan.run-now──▶ dispatching
 *   any: run.finished → plan.refresh-interval via backup-ledger (egress stretch)
 */
import { literal, statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, OPS_IO, SEND_ID } from '../schemas/events';

export interface BackupPlanData {
	planId: string;
	enabled: boolean;
	/** Effective interval (egress-stretched, ADR 0098). */
	intervalMs: number;
	/** Last scheduled (non-manual) run start; null → run now. */
	lastStartedAt: number | null;
	trigger: 'schedule' | 'catch-up' | 'manual';
	requestedBy: string | null;
	lastRefused: string | null;
}

export const BACKUP_PLAN_REVISION = 'v1';
export const BACKUP_PLAN_STATES = { restore: 'restore', armed: 'armed', dispatching: 'dispatching', paused: 'paused' } as const;

type Ctx = EvaluationContext<BackupPlanData>;
const ev = <T>(c: Ctx) => c.event!.data as T;

const dueIn = ({ data }: Ctx) => Math.max(0, (data.lastStartedAt ?? 0) + data.intervalMs - Date.now());
/** More than one interval missed → a single catch-up run. */
const scheduledTrigger = ({ data }: Ctx) =>
	data.lastStartedAt !== null && Date.now() - data.lastStartedAt > 2 * data.intervalMs ? 'catch-up' : 'schedule';

export function backupPlanChart(): DefinitionBuilder<BackupPlanData> {
	const S = BACKUP_PLAN_STATES;
	const refresh = (t: any) => t.send('plan.refresh-interval', (b: any) => b.via(OPS_IO.ledger).data(({ data }: Ctx) => ({ planId: data.planId })));
	return statechart<BackupPlanData>({ family: OPS_FAMILY.plan, revision: BACKUP_PLAN_REVISION, name: 'backup-plan' })
		.data('planId', 'plan')
		.data('enabled', true)
		.data('intervalMs', 3_600_000)
		.data('lastStartedAt', null)
		.data('trigger', 'schedule')
		.data('requestedBy', null)
		.data('lastRefused', null)
		.initial(S.restore)
		.state(S.restore, (s) => s.always((t) => t.when(({ data }: Ctx) => data.enabled).target(S.armed)).always((t) => t.target(S.paused)))
		.state(S.armed, (s) =>
			s
				.entry((a) => a.send('plan.tick', (b) => b.id(SEND_ID.tick).after(dueIn)))
				.exit((a) => a.cancel(SEND_ID.tick))
				.on('plan.tick', (t) => t.target(S.dispatching).assign('trigger', scheduledTrigger).assign('requestedBy', literal(null)))
				.on('plan.run-now', (t) =>
					t.target(S.dispatching).assign('trigger', literal('manual')).assign('requestedBy', (c: Ctx) => ev<{ requestedBy: string }>(c).requestedBy)
				)
				.on('plan.interval', (t) => t.target(S.armed).assign('intervalMs', (c: Ctx) => ev<{ effectiveIntervalMs: number }>(c).effectiveIntervalMs))
				.on('run.finished', refresh)
				.on('config.updated')
		)
		.state(S.dispatching, (s) =>
			s
				.entry((a) =>
					a.send('plan.dispatch', (b) =>
						b.via(OPS_IO.ledger).data(({ data }: Ctx) => ({ planId: data.planId, trigger: data.trigger, requestedBy: data.requestedBy }))
					)
				)
				.on('plan.dispatched', (t) =>
					t
						.target(S.restore)
						// Manual runs don't move the schedule; refused scheduled runs wait one interval.
						.assign('lastStartedAt', (c: Ctx) => (c.data.trigger === 'manual' ? c.data.lastStartedAt : ev<{ startedAt: number }>(c).startedAt))
						.assign('lastRefused', (c: Ctx) => ev<{ refused: string | null }>(c).refused)
				)
				.on('error.communication', (t) =>
					t.target(S.restore).assign('lastStartedAt', (c: Ctx) => (c.data.trigger === 'manual' ? c.data.lastStartedAt : Date.now()))
				)
				.on('plan.interval', (t) => t.assign('intervalMs', (c: Ctx) => ev<{ effectiveIntervalMs: number }>(c).effectiveIntervalMs))
				.on('run.finished', refresh)
				.on('plan.run-now')
				.on('plan.tick')
		)
		.state(S.paused, (s) =>
			s
				.on('plan.run-now', (t) =>
					t.target(S.dispatching).assign('trigger', literal('manual')).assign('requestedBy', (c: Ctx) => ev<{ requestedBy: string }>(c).requestedBy)
				)
				.on('plan.interval', (t) => t.assign('intervalMs', (c: Ctx) => ev<{ effectiveIntervalMs: number }>(c).effectiveIntervalMs))
				.on('run.finished', refresh)
				.on('plan.tick')
				.on('config.updated')
		);
}
