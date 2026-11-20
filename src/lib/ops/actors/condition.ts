/**
 * `condition/<id>` — one per watched condition (ADR 0100, 0101, 0123).
 * Virtual: spawned from its `conditions` row (at boot for a condition that
 * is not ok, or when the watchdog's sampler sends `signal.sample`). Every
 * decision is driven by samples (which carry their own time), so no timer
 * has to survive a restart.
 *
 *   ok ──breached (immediate kind)──▶ attention
 *   ok ──breached──▶ suspect
 *   suspect ──cleared──▶ ok (quietly)
 *   suspect ⇒ healing    when confirmed and the ladder has a next step
 *   suspect ⇒ attention  when the ladder is exhausted and the grace period passed
 *   healing (entry: remediate {next ladder action} → remediator/main)
 *     ──cleared──▶ ok (info: "handled")
 *     ⇒ healing (next step) / attention, after the settle period
 *   attention ──cleared──▶ ok   ──condition.acknowledge──▶ acknowledged
 *   acknowledged ──cleared──▶ ok (a recurrence starts over from ok)
 *
 * Each state entry journals the condition row (and an ops event when the
 * transition produced one) through the `journal` I/O processor.
 *
 * All of the condition's state is the one variable `d` (`ConditionData`),
 * changed in place by the chart's helpers. The policies (ladder, grace and
 * settle periods, titles) are `health/policies.ts`'s, embedded as the
 * helpers `policy(kind)` and `title(kind, subject, facts)`.
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, OPS_IO, REMEDIATOR_ADDRESS, opsName, type OpsEventData } from '../schemas/events';
import type { ConditionKind, ConditionState, OpsEventKind, RemediationAction } from '../schemas/conditions';
import { POLICIES, type ConditionPolicy } from '../health/policies';

export const JOURNAL_IO_TYPE = 'journal';
export const JOURNAL_CONDITION_EVENT = 'journal.condition';

export interface ConditionData {
	id: string;
	kind: ConditionKind;
	subject: string | null;
	/** Persisted state to resume in (spawn params); `ok` for new conditions. */
	resumeState: ConditionState;
	since: number | null;
	/** Consecutive breached samples. */
	breachedSamples: number;
	/** Next ladder index. */
	step: number;
	tried: RemediationAction[];
	lastActionAt: number | null;
	lastRemediation: { action: RemediationAction; at: number; outcome: 'done' | 'noop' | 'failed' } | null;
	facts: Record<string, unknown>;
	value: number | null;
	lastSampleAt: number;
	acknowledgedBy: string | null;
	/** Test hook: multiplies grace and settle periods. */
	timeScale: number;
	/** Event produced by the last transition, journaled on entry of its target. */
	note: { kind: OpsEventKind; message: string } | null;
}

export const initialConditionData = (): ConditionData => ({
	id: 'unset',
	kind: 'disk-low',
	subject: null,
	resumeState: 'ok',
	since: null,
	breachedSamples: 0,
	step: 0,
	tried: [],
	lastActionAt: null,
	lastRemediation: null,
	facts: {},
	value: null,
	lastSampleAt: 0,
	acknowledgedBy: null,
	timeScale: 1,
	note: null
});

/** What the journal processor receives. */
export interface JournalConditionRequest {
	id: string;
	kind: ConditionKind;
	subject: string | null;
	state: ConditionState;
	since: number | null;
	facts: Record<string, unknown>;
	step: number;
	tried: RemediationAction[];
	lastRemediation: ConditionData['lastRemediation'];
	acknowledgedBy: string | null;
	at: number;
	event: { kind: OpsEventKind; message: string } | null;
}

type Sample = OpsEventData<'signal.sample'>;
type Policy = Pick<ConditionPolicy, 'ladder' | 'graceMs' | 'settleMs' | 'confirm'>;

/** `policy(kind)`: the numbers of POLICIES, as a literal. */
const policyHelper = new Function(
	'kind',
	`return (${JSON.stringify(Object.fromEntries(Object.entries(POLICIES).map(([k, p]) => [k, { ladder: p.ladder, graceMs: p.graceMs, settleMs: p.settleMs, confirm: p.confirm }])))})[kind];`
);
/** `title(kind, subject, facts)`: each policy's `title`, by kind (each is self-contained). */
const titleHelper = new Function(
	'kind',
	'subject',
	'facts',
	`switch (kind) {\n${Object.entries(POLICIES)
		.map(([k, p]) => `case ${JSON.stringify(k)}: return (${p.title.toString()})(subject, facts);`)
		.join('\n')}\ndefault: return kind;\n}`
);

const helpers = {
	policy: policyHelper,
	title: titleHelper,
	immediate: (p: Policy) => p.ladder.length === 0 && p.graceMs === 0 && !p.confirm,
	absorb: (d: ConditionData, s: Sample) => {
		d.facts = s.facts;
		d.value = s.value;
		d.lastSampleAt = s.at;
		d.breachedSamples = s.breached ? d.breachedSamples + 1 : 0;
	},
	/** absorb, then start an episode (`since` = the sample's time) or end one (`since` = null). */
	restart: (d: ConditionData, s: Sample, starting: boolean) => {
		d.facts = s.facts;
		d.value = s.value;
		d.lastSampleAt = s.at;
		d.breachedSamples = s.breached ? d.breachedSamples + 1 : 0;
		d.since = starting ? s.at : null;
		d.step = 0;
		d.tried = [];
		d.lastActionAt = null;
		d.acknowledgedBy = null;
	},
	note: (d: ConditionData, kind: OpsEventKind, message: string) => {
		d.note = { kind, message };
	},
	confirmed: (d: ConditionData, p: Policy) => !p.confirm || d.breachedSamples >= 2,
	settled: (d: ConditionData, p: Policy) => d.lastActionAt === null || d.lastSampleAt - d.lastActionAt >= p.settleMs * d.timeScale,
	hasNextStep: (d: ConditionData, p: Policy) => d.step < p.ladder.length,
	graceOver: (d: ConditionData, p: Policy) => d.since !== null && d.lastSampleAt - d.since >= p.graceMs * d.timeScale,
	journal: (d: ConditionData, state: ConditionState): JournalConditionRequest => {
		const event = d.note;
		d.note = null;
		return {
			id: d.id,
			kind: d.kind,
			subject: d.subject,
			state,
			since: state === 'ok' ? null : d.since,
			facts: d.facts,
			step: d.step,
			tried: d.tried,
			lastRemediation: d.lastRemediation,
			acknowledgedBy: d.acknowledgedBy,
			at: d.lastSampleAt || Date.now(),
			event
		};
	},
	nextAction: (d: ConditionData, p: Policy): OpsEventData<'remediate'> => {
		const action = p.ladder[d.step]!;
		d.step++;
		d.tried = [...d.tried, action];
		d.lastActionAt = d.lastSampleAt || Date.now();
		return { conditionId: d.id, action, attempt: d.step };
	},
	recordRemediation: (d: ConditionData, name: string, r: { action: RemediationAction; outcome?: 'done' | 'noop' }) => {
		d.lastRemediation = { action: r.action, at: Date.now(), outcome: name === 'remediation.failed' ? 'failed' : (r.outcome ?? 'done') };
	}
};

const P = 'policy(d.kind)';
const TITLE = 'title(d.kind, d.subject, d.facts)';
const journal = (state: ConditionState) => scxml`<send type="${JOURNAL_IO_TYPE}" event="${JOURNAL_CONDITION_EVENT}"><content expr="${`journal(d, '${state}')`}"/></send>`;
const absorb = scxml`<transition event="signal.sample"><script>absorb(d, _event.data)</script></transition>`;
const remediations = scxml`
	<transition event="remediated"><script>recordRemediation(d, _event.name, _event.data)</script></transition>
	<transition event="remediation.failed"><script>recordRemediation(d, _event.name, _event.data)</script></transition>`;
/** A cleared sample: back to ok with an info note (`message`, JavaScript), the episode ended. */
const resolved = (message: string, extra = '') => scxml`
	<transition event="signal.sample" cond="!_event.data.breached" target="ok">
		<script>${`note(d, 'info', ${message});${extra} restart(d, _event.data, false);`}</script>
	</transition>`;
const toAttention = (guard: string) => scxml`
	<transition cond="${guard}" target="attention"><script>${`note(d, 'attention', ${TITLE});`}</script></transition>`;

export const conditionChart = chart({
	name: OPS_FAMILY.condition,
	initial: 'restore',
	helpers,
	data: { d: initialConditionData() },
	body: scxml`
<!-- Resume where the persisted row left off, without re-running side effects:
     healing resumes as suspect (the ladder position is kept), notes are empty. -->
<state id="restore">
	<transition cond="d.resumeState === 'attention'" target="attention"/>
	<transition cond="d.resumeState === 'acknowledged'" target="acknowledged"/>
	<transition cond="${"d.resumeState === 'suspect' || d.resumeState === 'healing'"}" target="suspect"/>
	<transition target="ok"/>
</state>

<state id="ok">
	<onentry>${journal('ok')}</onentry>
	<transition event="signal.sample" cond="${`_event.data.breached && immediate(${P})`}" target="attention">
		<script>${`restart(d, _event.data, true); note(d, 'attention', ${TITLE});`}</script>
	</transition>
	<transition event="signal.sample" cond="_event.data.breached" target="suspect"><script>restart(d, _event.data, true)</script></transition>
	${absorb}
</state>

<state id="suspect">
	<onentry>${journal('suspect')}</onentry>
	<transition cond="${`confirmed(d, ${P}) && settled(d, ${P}) && hasNextStep(d, ${P})`}" target="healing"/>
	${toAttention(`confirmed(d, ${P}) && settled(d, ${P}) && !hasNextStep(d, ${P}) && graceOver(d, ${P})`)}
	${resolved(`d.tried.length ? 'Resolved after ' + d.tried.join(', ') + ': ' + ${TITLE} : 'Cleared: ' + ${TITLE}`, ' if (!d.tried.length) d.note = null;')}
	${absorb}
	${remediations}
</state>

<state id="healing">
	<onentry>
		<send type="${OPS_IO.route}" event="remediate" target="${opsName(REMEDIATOR_ADDRESS)}"><content expr="${`nextAction(d, ${P})`}"/></send>
		${journal('healing')}
	</onentry>
	<transition cond="${`settled(d, ${P}) && hasNextStep(d, ${P})`}" target="healing"/>
	${toAttention(`settled(d, ${P}) && !hasNextStep(d, ${P}) && graceOver(d, ${P})`)}
	${resolved(`'Handled automatically (' + d.tried.join(', ') + '): ' + ${TITLE}`)}
	${absorb}
	${remediations}
</state>

<state id="attention">
	<onentry>${journal('attention')}</onentry>
	${resolved(`'Resolved: ' + ${TITLE}`)}
	${absorb}
	<transition event="condition.acknowledge" target="acknowledged">
		<script>${`d.acknowledgedBy = _event.data.by; note(d, 'ack', 'Acknowledged by ' + d.acknowledgedBy + ': ' + ${TITLE});`}</script>
	</transition>
</state>

<state id="acknowledged">
	<onentry>${journal('acknowledged')}</onentry>
	${resolved(`'Resolved: ' + ${TITLE}`)}
	${absorb}
</state>`
});
