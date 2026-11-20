/**
 * `backup-plan/<planId>` — the schedule of one plan (ADR 0082, 0098, 0111).
 * Spawned by the ledger's reconcile with params derived from ops.sqlite
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
import { chart, scxml } from '../../charts';
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

export const BACKUP_PLAN_STATES = { restore: 'restore', armed: 'armed', dispatching: 'dispatching', paused: 'paused' } as const;

const S = BACKUP_PLAN_STATES;

const helpers = {
	/** Milliseconds until the next scheduled run. */
	dueIn: (lastStartedAt: number | null, intervalMs: number) => Math.max(0, (lastStartedAt ?? 0) + intervalMs - Date.now()),
	/** More than one interval missed → a single catch-up run. */
	scheduledTrigger: (lastStartedAt: number | null, intervalMs: number) =>
		lastStartedAt !== null && Date.now() - lastStartedAt > 2 * intervalMs ? 'catch-up' : 'schedule'
};

const refresh = scxml`<send type="${OPS_IO.ledger}" event="plan.refresh-interval"><content expr="({ planId: planId })"/></send>`;
const runNow = (target: string) => scxml`
	<transition event="plan.run-now" target="${target}">
		<assign location="trigger" expr="'manual'"/>
		<assign location="requestedBy" expr="_event.data.requestedBy"/>
	</transition>`;

export const backupPlanChart = chart({
	name: OPS_FAMILY.plan,
	initial: S.restore,
	helpers,
	data: { planId: 'plan', enabled: true, intervalMs: 3_600_000, lastStartedAt: null, trigger: 'schedule', requestedBy: null, lastRefused: null } satisfies BackupPlanData,
	body: scxml`
<state id="${S.restore}">
	<transition cond="enabled" target="${S.armed}"/>
	<transition target="${S.paused}"/>
</state>
<state id="${S.armed}">
	<onentry><send event="plan.tick" id="${SEND_ID.tick}" delayexpr="dueIn(lastStartedAt, intervalMs) + 'ms'"/></onentry>
	<onexit><cancel sendid="${SEND_ID.tick}"/></onexit>
	<transition event="plan.tick" target="${S.dispatching}">
		<assign location="trigger" expr="scheduledTrigger(lastStartedAt, intervalMs)"/>
		<assign location="requestedBy" expr="null"/>
	</transition>
	${runNow(S.dispatching)}
	<transition event="plan.interval" target="${S.armed}"><assign location="intervalMs" expr="_event.data.effectiveIntervalMs"/></transition>
	<transition event="run.finished">${refresh}</transition>
</state>
<state id="${S.dispatching}">
	<onentry>
		<send type="${OPS_IO.ledger}" event="plan.dispatch"><content expr="({ planId: planId, trigger: trigger, requestedBy: requestedBy })"/></send>
	</onentry>
	<!-- Manual runs don't move the schedule; refused scheduled runs wait one interval. -->
	<transition event="plan.dispatched" target="${S.restore}">
		<assign location="lastStartedAt" expr="${"trigger === 'manual' ? lastStartedAt : _event.data.startedAt"}"/>
		<assign location="lastRefused" expr="_event.data.refused"/>
	</transition>
	<transition event="error.communication" target="${S.restore}">
		<assign location="lastStartedAt" expr="${"trigger === 'manual' ? lastStartedAt : Date.now()"}"/>
	</transition>
	<transition event="plan.interval"><assign location="intervalMs" expr="_event.data.effectiveIntervalMs"/></transition>
	<transition event="run.finished">${refresh}</transition>
</state>
<state id="${S.paused}">
	${runNow(S.dispatching)}
	<transition event="plan.interval"><assign location="intervalMs" expr="_event.data.effectiveIntervalMs"/></transition>
	<transition event="run.finished">${refresh}</transition>
</state>`
});
