/**
 * `remediator/main` — runs one self-healing action at a time (ADR 0101, 0123).
 *
 *   idle ──remediate──▶ working
 *   working (entry: <send type="remediate"> remediate.run {head of queue})
 *     ──remediated | remediation.failed (from the processor)──▶
 *         forward to condition/<id> (by name, through ops-route), then working (next) | idle
 *   remediate while working → queued (deduplicated by condition + action)
 *
 * Every action is idempotent and re-derivable from current facts, so a
 * crash mid-remediation just re-evaluates on the next watchdog sample.
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, OPS_IO, type OpsEventData } from '../schemas/events';

export const REMEDIATE_IO_TYPE = 'remediate';
export const REMEDIATE_RUN_EVENT = 'remediate.run';

type Request = OpsEventData<'remediate'>;

export interface RemediatorData {
	queue: Request[];
	current: Request | null;
	done: number;
	failed: number;
}

const helpers = {
	/** Queue a request unless the same condition + action is current or queued. */
	enqueued: (queue: Request[], current: Request | null, r: Request) => {
		const dup = (x: Request | null) => !!x && x.conditionId === r.conditionId && x.action === r.action;
		return dup(current) || queue.some(dup) ? queue : [...queue, r];
	}
};

const enqueue = scxml`<assign location="queue" expr="enqueued(queue, current, _event.data)"/>`;

/** Forward the processor's answer to the condition, then the next request or rest. */
const finish = (event: 'remediated' | 'remediation.failed', counter: 'done' | 'failed') => scxml`
	<transition event="${event}" cond="queue.length > 0" target="working">
		<send type="${OPS_IO.route}" event="${event}" targetexpr="${`'${OPS_FAMILY.condition}/' + _event.data.conditionId`}"><content expr="_event.data"/></send>
		<assign location="${counter}" expr="${counter} + 1"/>
		<assign location="current" expr="null"/>
	</transition>
	<transition event="${event}" target="idle">
		<send type="${OPS_IO.route}" event="${event}" targetexpr="${`'${OPS_FAMILY.condition}/' + _event.data.conditionId`}"><content expr="_event.data"/></send>
		<assign location="${counter}" expr="${counter} + 1"/>
		<assign location="current" expr="null"/>
	</transition>`;

export const remediatorChart = chart({
	name: OPS_FAMILY.remediator,
	initial: 'idle',
	helpers,
	data: { queue: [], current: null, done: 0, failed: 0 } satisfies RemediatorData,
	body: scxml`
<state id="idle">
	<transition event="remediate" target="working">${enqueue}</transition>
</state>
<state id="working">
	<onentry>
		<assign location="current" expr="queue[0] ?? null"/>
		<assign location="queue" expr="queue.slice(1)"/>
		<send type="${REMEDIATE_IO_TYPE}" event="${REMEDIATE_RUN_EVENT}"><content expr="current"/></send>
	</onentry>
	<transition event="remediate">${enqueue}</transition>
	${finish('remediated', 'done')}
	${finish('remediation.failed', 'failed')}
	<transition event="error.communication" target="idle">
		<assign location="current" expr="null"/>
		<assign location="failed" expr="failed + 1"/>
	</transition>
</state>`
});
