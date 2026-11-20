/**
 * `issue/<repoId>-<number>` — one actor per issue or pull request
 * (ADR 0002, ADR 0033, ADR 0280: `issue.opened` data carries `kind`, which
 * the close request passes on to the relay). Spawned before its first event
 * with `params` built from SQLite (`issueParams`, ADR 0300); it ends when it
 * finishes, and its `<donedata>` reaches the host's `onDone`.
 *
 *   restore ──(phase closing)──────────────────────────────▶ closing
 *      └────(phase new | settled)──▶ idle
 *   idle ──issue.opened (phase settled)──▶ settled
 *   idle ──issue.opened──▶ checking
 *   checking ──allowlist.verdict allowed──▶ allowed
 *   checking ──allowlist.verdict not allowed──▶ closing
 *   checking ──check.timeout (10 s, send id check-timeout)──▶ failed
 *   closing (entry: <send type="github"> github.close)
 *      ──github.closed──▶ closed   ──github.gave-up──▶ failed
 *      issue.opened in closing is ignored (duplicate deliveries).
 *
 * Final states `allowed | closed | failed | settled` report `IssueDoneData`.
 */
import { Address, type Source } from '@tinyactors/node';
import { chart, scxml, lit } from '../../charts';
import {
	ALLOWLIST_ADDRESS,
	CHECK_TIMEOUT_MS,
	CHECK_TIMEOUT_SEND_ID,
	EVENTS,
	FAMILY,
	GITHUB_IO_TYPE,
	GRANARY_SYSTEM,
	OUTCOME_REASONS,
	formatAddress,
	type GitHubCloseData,
	type IssueActorData,
	type IssueDoneData,
	type IssueOpenedData,
	type IssueOutcome
} from '../../schemas/actors';

export type { IssueActorData, IssueDoneData };

/** State names; tests observe them through traces (ADR 0042). */
export const ISSUE_STATES = {
	restore: 'restore',
	idle: 'idle',
	checking: 'checking',
	closing: 'closing',
	allowed: 'allowed',
	closed: 'closed',
	failed: 'failed',
	settled: 'settled'
} as const;

/** The `github.close` request for the issue the actor holds (a chart helper: self-contained). */
function closeRequest(i: IssueOpenedData, deliveryId: string | null): GitHubCloseData {
	return {
		...(i.kind === 'pull_request' ? { kind: 'pull_request' as const } : {}),
		repoId: i.repoId,
		owner: i.owner,
		repo: i.repo,
		number: i.number,
		author: i.author,
		association: i.association,
		title: i.title,
		htmlUrl: i.htmlUrl,
		deliveryId: deliveryId ?? i.deliveryId
	};
}

/** `<donedata>` of a final state: `IssueDoneData` with `verdict` and the reason so far (default: the verdict). */
const done = (verdict: IssueOutcome, reason = 'reason') =>
	scxml`<donedata><content expr="${`({ issueKey, deliveryId, verdict: ${lit(verdict)}, reason: ${reason} ?? ${lit(verdict)} })`}"/></donedata>`;

export function issueChart(): Source {
	const S = ISSUE_STATES;
	const allowlist = Address.fromName(GRANARY_SYSTEM, formatAddress(ALLOWLIST_ADDRESS)).text;
	const gaveUp = lit(OUTCOME_REASONS.gaveUp(''));
	const initial: IssueActorData = { issueKey: '0-0', phase: 'new', issue: null, deliveryId: null, verdict: null, reason: null };
	return chart({
		name: FAMILY.issue,
		initial: S.restore,
		helpers: { closeRequest },
		data: initial,
		body: scxml`
<!-- Route on the spawn's params.phase. -->
<state id="${S.restore}">
	<transition cond="${"phase === 'closing' && issue !== null"}" target="${S.closing}"/>
	<transition target="${S.idle}"/>
</state>

<state id="${S.idle}">
	<transition event="${EVENTS.issueOpened}" cond="${"phase === 'settled'"}" target="${S.settled}">
		<assign location="deliveryId" expr="_event.data.deliveryId"/>
	</transition>
	<transition event="${EVENTS.issueOpened}" target="${S.checking}">
		<assign location="issue" expr="_event.data"/>
		<assign location="deliveryId" expr="_event.data.deliveryId"/>
	</transition>
	<!-- A late relay reply for an issue that was already decided. -->
	<transition event="${EVENTS.githubClosed}" cond="${"phase === 'settled'"}" target="${S.settled}"/>
	<transition event="${EVENTS.githubGaveUp}" cond="${"phase === 'settled'"}" target="${S.settled}"/>
</state>

<state id="${S.checking}">
	<onentry>
		<send event="${EVENTS.allowlistCheck}" target="${allowlist}"><content expr="({ login: issue.author, association: issue.association, owner: issue.owner, repo: issue.repo })"/></send>
		<send id="${CHECK_TIMEOUT_SEND_ID}" event="${EVENTS.checkTimeout}" delay="${`${CHECK_TIMEOUT_MS}ms`}"/>
	</onentry>
	<onexit><cancel sendid="${CHECK_TIMEOUT_SEND_ID}"/></onexit>
	<transition event="${EVENTS.allowlistVerdict}" cond="_event.data.allowed" target="${S.allowed}">
		<assign location="reason" expr="_event.data.reason"/>
	</transition>
	<transition event="${EVENTS.allowlistVerdict}" target="${S.closing}">
		<assign location="reason" expr="_event.data.reason"/>
	</transition>
	<transition event="${EVENTS.checkTimeout}" target="${S.failed}">
		<assign location="reason" expr="${lit(OUTCOME_REASONS.checkTimeout)}"/>
	</transition>
</state>

<state id="${S.closing}">
	<onentry>
		<assign location="phase" expr="'closing'"/>
		<send type="${GITHUB_IO_TYPE}" event="${EVENTS.githubClose}"><content expr="closeRequest(issue, deliveryId)"/></send>
	</onentry>
	<!-- Keep the verdict's reason (not-allowed or blocklist); a closing issue restored
	     from the outbox after a restart has none, so it reports not-allowed. -->
	<transition event="${EVENTS.githubClosed}" target="${S.closed}">
		<assign location="reason" expr="${`reason ?? ${lit(OUTCOME_REASONS.notAllowed)}`}"/>
	</transition>
	<transition event="${EVENTS.githubGaveUp}" target="${S.failed}">
		<assign location="reason" expr="${`${gaveUp} + _event.data.lastError`}"/>
	</transition>
	<!-- The github I/O processor failed the send (outbox not written). -->
	<transition event="error.communication" target="${S.failed}">
		<assign location="reason" expr="${`${gaveUp} + 'outbox write failed'`}"/>
	</transition>
</state>

<final id="${S.allowed}">
	<onentry><assign location="verdict" expr="'allowed'"/></onentry>
	${done('allowed')}
</final>
<final id="${S.closed}">
	<onentry><assign location="verdict" expr="'closed'"/></onentry>
	${done('closed')}
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
