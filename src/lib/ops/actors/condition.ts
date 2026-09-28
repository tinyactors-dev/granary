/**
 * `condition/<id>` — one per watched condition (ADR 0100, 0101, 0123).
 * Virtual: loaded from the `conditions` table by the family loader when the
 * watchdog's sampler posts `signal.sample`. Every decision is driven by
 * samples (which carry their own time), so no timer has to survive a
 * restart.
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
 */
import { statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, REMEDIATOR_ADDRESS, opsTargetUri, type OpsEventData } from '../schemas/events';
import type { ConditionKind, ConditionState, OpsEventKind, RemediationAction } from '../schemas/conditions';
import { policyFor } from '../health/policies';

export const CONDITION_REVISION = 'v1';
export const JOURNAL_IO_TYPE = 'journal';
export const JOURNAL_CONDITION_EVENT = 'journal.condition';

export interface ConditionData {
	id: string;
	kind: ConditionKind;
	subject: string | null;
	/** Persisted state to resume in (loader binding); `ok` for new conditions. */
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

type Ctx = EvaluationContext<ConditionData>;
type Sample = OpsEventData<'signal.sample'>;

const sample = (ctx: Ctx) => ctx.event!.data as Sample;
const policy = ({ data }: Ctx) => policyFor(data.kind);
const breached = (ctx: Ctx) => sample(ctx).breached;
const cleared = (ctx: Ctx) => !sample(ctx).breached;
const immediate = (ctx: Ctx) => {
	const p = policy(ctx);
	return p.ladder.length === 0 && p.graceMs === 0 && !p.confirm;
};

function absorb(ctx: Ctx) {
	const s = sample(ctx);
	ctx.data.facts = s.facts;
	ctx.data.value = s.value;
	ctx.data.lastSampleAt = s.at;
	ctx.data.breachedSamples = s.breached ? ctx.data.breachedSamples + 1 : 0;
}

function begin(ctx: Ctx) {
	absorb(ctx);
	ctx.data.since = sample(ctx).at;
	ctx.data.step = 0;
	ctx.data.tried = [];
	ctx.data.lastActionAt = null;
	ctx.data.acknowledgedBy = null;
}

const title = ({ data }: Ctx) => policyFor(data.kind).title(data.subject, data.facts);
const note = (kind: OpsEventKind, message: (ctx: Ctx) => string) => (ctx: Ctx) => {
	ctx.data.note = { kind, message: message(ctx) };
};
function reset(ctx: Ctx) {
	absorb(ctx);
	ctx.data.since = null;
	ctx.data.step = 0;
	ctx.data.tried = [];
	ctx.data.lastActionAt = null;
	ctx.data.acknowledgedBy = null;
}

const confirmed = (ctx: Ctx) => !policy(ctx).confirm || ctx.data.breachedSamples >= 2;
const settled = ({ data }: Ctx) => data.lastActionAt === null || data.lastSampleAt - data.lastActionAt >= policyFor(data.kind).settleMs * data.timeScale;
const hasNextStep = (ctx: Ctx) => ctx.data.step < policy(ctx).ladder.length;
const graceOver = ({ data }: Ctx) => data.since !== null && data.lastSampleAt - data.since >= policyFor(data.kind).graceMs * data.timeScale;

function journal(state: ConditionState) {
	return ({ data }: Ctx): JournalConditionRequest => {
		const event = data.note;
		data.note = null;
		return {
			id: data.id,
			kind: data.kind,
			subject: data.subject,
			state,
			since: state === 'ok' ? null : data.since,
			facts: data.facts,
			step: data.step,
			tried: data.tried,
			lastRemediation: data.lastRemediation,
			acknowledgedBy: data.acknowledgedBy,
			at: data.lastSampleAt || Date.now(),
			event
		};
	};
}

function nextAction(ctx: Ctx): OpsEventData<'remediate'> {
	const d = ctx.data;
	const action = policyFor(d.kind).ladder[d.step]!;
	d.step++;
	d.tried = [...d.tried, action];
	d.lastActionAt = d.lastSampleAt || Date.now();
	return { conditionId: d.id, action, attempt: d.step };
}

function recordRemediation(ctx: Ctx) {
	const e = ctx.event!;
	const r = e.data as { action: RemediationAction; outcome?: 'done' | 'noop' };
	ctx.data.lastRemediation = { action: r.action, at: Date.now(), outcome: e.name === 'remediation.failed' ? 'failed' : (r.outcome ?? 'done') };
}

export function conditionChart(): DefinitionBuilder<ConditionData> {
	return (
		statechart<ConditionData>({ family: OPS_FAMILY.condition, revision: CONDITION_REVISION, name: 'condition' })
			.data('id', 'unset')
			.data('kind', 'disk-low')
			.data('subject', null)
			.data('resumeState', 'ok')
			.data('since', null)
			.data('breachedSamples', 0)
			.data('step', 0)
			.data('tried', [])
			.data('lastActionAt', null)
			.data('lastRemediation', null)
			.data('facts', {})
			.data('value', null)
			.data('lastSampleAt', 0)
			.data('acknowledgedBy', null)
			.data('timeScale', 1)
			.data('note', null)
			.initial('restore')

			// Resume where the persisted row left off, without re-running side effects:
			// healing resumes as suspect (the ladder position is kept), notes are empty.
			.state('restore', (s) =>
				s
					.always((t) => t.when(({ data }: Ctx) => data.resumeState === 'attention').target('attention'))
					.always((t) => t.when(({ data }: Ctx) => data.resumeState === 'acknowledged').target('acknowledged'))
					.always((t) => t.when(({ data }: Ctx) => data.resumeState === 'suspect' || data.resumeState === 'healing').target('suspect'))
					.always((t) => t.target('ok'))
			)

			.state('ok', (s) =>
				s
					.entry((a) => a.send(JOURNAL_CONDITION_EVENT, (b) => b.via(JOURNAL_IO_TYPE).data(journal('ok'))))
					.on('signal.sample', (t) => t.when((c: Ctx) => breached(c) && immediate(c)).target('attention').script(begin).script(note('attention', title)))
					.on('signal.sample', (t) => t.when(breached).target('suspect').script(begin))
					.on('signal.sample', (t) => t.internal().script(absorb))
			)

			.state('suspect', (s) =>
				s
					.entry((a) => a.send(JOURNAL_CONDITION_EVENT, (b) => b.via(JOURNAL_IO_TYPE).data(journal('suspect'))))
					.always((t) => t.when((c: Ctx) => confirmed(c) && settled(c) && hasNextStep(c)).target('healing'))
					.always((t) => t.when((c: Ctx) => confirmed(c) && settled(c) && !hasNextStep(c) && graceOver(c)).target('attention').script(note('attention', title)))
					.on('signal.sample', (t) =>
						t
							.when(cleared)
							.target('ok')
							.script(
								note('info', (c) => (c.data.tried.length ? `Resolved after ${c.data.tried.join(', ')}: ${title(c)}` : `Cleared: ${title(c)}`))
							)
							.script((c: Ctx) => {
								if (!c.data.tried.length) c.data.note = null; // blips are not news
							})
							.script(reset)
					)
					.on('signal.sample', (t) => t.internal().script(absorb))
					.on('remediated', (t) => t.internal().script(recordRemediation))
					.on('remediation.failed', (t) => t.internal().script(recordRemediation))
			)

			.state('healing', (s) =>
				s
					.entry((a) =>
						a
							.send('remediate', (b) => b.to(opsTargetUri(REMEDIATOR_ADDRESS)).data(nextAction))
							.send(JOURNAL_CONDITION_EVENT, (b) => b.via(JOURNAL_IO_TYPE).data(journal('healing')))
					)
					.always((t) => t.when((c: Ctx) => settled(c) && hasNextStep(c)).target('healing'))
					.always((t) => t.when((c: Ctx) => settled(c) && !hasNextStep(c) && graceOver(c)).target('attention').script(note('attention', title)))
					.on('signal.sample', (t) =>
						t
							.when(cleared)
							.target('ok')
							.script(note('info', (c) => `Handled automatically (${c.data.tried.join(', ')}): ${title(c)}`))
							.script(reset)
					)
					.on('signal.sample', (t) => t.internal().script(absorb))
					.on('remediated', (t) => t.internal().script(recordRemediation))
					.on('remediation.failed', (t) => t.internal().script(recordRemediation))
			)

			.state('attention', (s) =>
				s
					.entry((a) => a.send(JOURNAL_CONDITION_EVENT, (b) => b.via(JOURNAL_IO_TYPE).data(journal('attention'))))
					.on('signal.sample', (t) => t.when(cleared).target('ok').script(note('info', (c) => `Resolved: ${title(c)}`)).script(reset))
					.on('signal.sample', (t) => t.internal().script(absorb))
					.on('condition.acknowledge', (t) =>
						t
							.target('acknowledged')
							.script((c: Ctx) => {
								c.data.acknowledgedBy = (c.event!.data as { by: string }).by;
							})
							.script(note('ack', (c) => `Acknowledged by ${c.data.acknowledgedBy}: ${title(c)}`))
					)
			)

			.state('acknowledged', (s) =>
				s
					.entry((a) => a.send(JOURNAL_CONDITION_EVENT, (b) => b.via(JOURNAL_IO_TYPE).data(journal('acknowledged'))))
					.on('signal.sample', (t) => t.when(cleared).target('ok').script(note('info', (c) => `Resolved: ${title(c)}`)).script(reset))
					.on('signal.sample', (t) => t.internal().script(absorb))
					.on('condition.acknowledge')
			)
	);
}
