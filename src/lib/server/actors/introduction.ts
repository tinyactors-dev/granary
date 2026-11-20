/**
 * `introduction/<repoId>-<number>` — one actor per introduction, a
 * discussion in an Introductions category (ADR 0310). The webhook route
 * records the introduction; this actor carries out an admin's decision.
 * Spawned on demand with params built from SQLite (`introductionParams`);
 * it ends when it finishes, and its `<donedata>` reaches the host's `onDone`.
 *
 *   restore ──(phase approving)──▶ approving
 *      ├────(phase settled)──────▶ idle-settled
 *      └────(phase pending)──────▶ deciding
 *   deciding ──introduction.approve──▶ approving
 *   deciding ──introduction.decline──▶ declined
 *   approving (entry: <send type="github"> github.approve)
 *      ──github.approved──▶ approved   ──github.gave-up──▶ failed
 *   idle-settled ──introduction.approve | decline | github.*──▶ settled
 *
 * Final states `approved | declined | failed | settled` report
 * `IntroductionDoneData`.
 */
import type { Source } from '@tinyactors/node';
import { chart, scxml, lit } from '../../charts';
import {
	EVENTS,
	FAMILY,
	GITHUB_IO_TYPE,
	OUTCOME_REASONS,
	type IntroductionActorData,
	type IntroductionOutcome
} from '../../schemas/actors';

export type { IntroductionActorData };

/** State names; tests observe them through traces (ADR 0042). */
export const INTRODUCTION_STATES = {
	restore: 'restore',
	deciding: 'deciding',
	approving: 'approving',
	idleSettled: 'idle-settled',
	approved: 'approved',
	declined: 'declined',
	failed: 'failed',
	settled: 'settled'
} as const;

/** `<donedata>` of a final state: `IntroductionDoneData`. */
const done = (verdict: IntroductionOutcome) =>
	scxml`<donedata><content expr="${`({ introKey, verdict: ${lit(verdict)}, by, note, reason: reason ?? ${lit(verdict)} })`}"/></donedata>`;

export function introductionChart(): Source {
	const S = INTRODUCTION_STATES;
	const gaveUp = lit(OUTCOME_REASONS.gaveUp(''));
	const initial: IntroductionActorData = { introKey: '0-0', phase: 'pending', by: null, note: null, verdict: null, reason: null };
	return chart({
		name: FAMILY.introduction,
		initial: S.restore,
		data: initial,
		body: scxml`
<!-- Route on the spawn's params.phase. -->
<state id="${S.restore}">
	<transition cond="${"phase === 'approving'"}" target="${S.approving}"/>
	<transition cond="${"phase === 'settled'"}" target="${S.idleSettled}"/>
	<transition target="${S.deciding}"/>
</state>

<state id="${S.deciding}">
	<transition event="${EVENTS.introductionApprove}" target="${S.approving}">
		<assign location="by" expr="_event.data.by"/>
	</transition>
	<transition event="${EVENTS.introductionDecline}" target="${S.declined}">
		<assign location="by" expr="_event.data.by"/>
		<assign location="note" expr="_event.data.note"/>
	</transition>
</state>

<state id="${S.approving}">
	<onentry>
		<assign location="phase" expr="'approving'"/>
		<send type="${GITHUB_IO_TYPE}" event="${EVENTS.githubApprove}"><content expr="({ introKey, by: by ?? 'granary' })"/></send>
	</onentry>
	<!-- A second click while it is being carried out changes nothing. -->
	<transition event="${EVENTS.introductionApprove}"/>
	<transition event="${EVENTS.githubApproved}" target="${S.approved}">
		<assign location="reason" expr="${"'reopened ' + _event.data.reopened"}"/>
	</transition>
	<transition event="${EVENTS.githubGaveUp}" target="${S.failed}">
		<assign location="reason" expr="${`${gaveUp} + _event.data.lastError`}"/>
	</transition>
	<!-- The github I/O processor failed the send (unknown or already decided introduction, outbox not written). -->
	<transition event="error.communication" target="${S.failed}">
		<assign location="reason" expr="${`${gaveUp} + 'the approval could not be recorded'`}"/>
	</transition>
</state>

<!-- Decided before: whatever comes now ends the actor without changing anything. -->
<state id="${S.idleSettled}">
	<transition event="${EVENTS.introductionApprove}" target="${S.settled}"/>
	<transition event="${EVENTS.introductionDecline}" target="${S.settled}"/>
	<transition event="${EVENTS.githubApproved}" target="${S.settled}"/>
	<transition event="${EVENTS.githubGaveUp}" target="${S.settled}"/>
</state>

<final id="${S.approved}">
	<onentry><assign location="verdict" expr="'approved'"/></onentry>
	${done('approved')}
</final>
<final id="${S.declined}">
	<onentry><assign location="verdict" expr="'declined'"/></onentry>
	${done('declined')}
</final>
<final id="${S.failed}">
	<onentry><assign location="verdict" expr="'failed'"/></onentry>
	${done('failed')}
</final>
<final id="${S.settled}">
	<onentry>
		<assign location="verdict" expr="'settled'"/>
		<assign location="reason" expr="${lit(OUTCOME_REASONS.alreadySettled)}"/>
	</onentry>
	${done('settled')}
</final>`
	});
}
