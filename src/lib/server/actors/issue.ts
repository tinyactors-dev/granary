/**
 * `issue/<repoId>-<number>` — one virtual actor per issue or pull request
 * (ADR 0002, ADR 0033, ADR 0280: `issue.opened` data carries `kind`, which
 * the close request passes on to the relay). Spawned by the `issue` family loader with an
 * `IssueActorData` binding built from SQLite; destroyed when it finishes.
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
 * Final states `allowed | closed | failed | settled` report `IssueDoneData`,
 * which the system `done` hook writes to SQLite.
 */
import { literal, statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import {
	ALLOWLIST_ADDRESS,
	CHECK_TIMEOUT_MS,
	CHECK_TIMEOUT_SEND_ID,
	EVENTS,
	FAMILY,
	GITHUB_IO_TYPE,
	OUTCOME_REASONS,
	actorTargetUri,
	type AllowlistCheckData,
	type AllowlistVerdictData,
	type GitHubCloseData,
	type GitHubGaveUpData,
	type IssueActorData,
	type IssueDoneData,
	type IssueOpenedData,
	type IssueOutcome
} from '../../schemas/actors';

export type { IssueActorData, IssueDoneData };

export const ISSUE_REVISION = 'v2';

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

type Ctx = EvaluationContext<IssueActorData>;

const eventData = <T>(ctx: Ctx): T => ctx.event!.data as T;

function doneData(verdict: IssueOutcome) {
	return ({ data }: Ctx): IssueDoneData => ({
		issueKey: data.issueKey,
		deliveryId: data.deliveryId,
		verdict,
		reason: data.reason ?? verdict
	});
}

function closeRequest({ data }: Ctx): GitHubCloseData {
	const i = data.issue!;
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
		deliveryId: data.deliveryId ?? i.deliveryId
	};
}

export function issueChart(): DefinitionBuilder<IssueActorData> {
	const S = ISSUE_STATES;
	return (
		statechart<IssueActorData>({ family: FAMILY.issue, revision: ISSUE_REVISION, name: 'issue' })
			.data('issueKey', '0-0')
			.data('phase', 'new')
			.data('issue', null)
			.data('deliveryId', null)
			.data('verdict', null)
			.data('reason', null)
			.initial(S.restore)

			// Route on the loader's binding.phase.
			.state(S.restore, (s) =>
				s
					.always((t) => t.when(({ data }: Ctx) => data.phase === 'closing' && data.issue !== null).target(S.closing))
					.always((t) => t.target(S.idle))
			)

			.state(S.idle, (s) =>
				s
					.on(EVENTS.issueOpened, (t) =>
						t
							.when(({ data }: Ctx) => data.phase === 'settled')
							.target(S.settled)
							.assign('deliveryId', (ctx: Ctx) => eventData<IssueOpenedData>(ctx).deliveryId)
					)
					.on(EVENTS.issueOpened, (t) =>
						t
							.target(S.checking)
							.assign('issue', (ctx: Ctx) => eventData<IssueOpenedData>(ctx))
							.assign('deliveryId', (ctx: Ctx) => eventData<IssueOpenedData>(ctx).deliveryId)
					)
					// A late relay reply for an issue that was already decided.
					.on(EVENTS.githubClosed, (t) => t.when(({ data }: Ctx) => data.phase === 'settled').target(S.settled))
					.on(EVENTS.githubGaveUp, (t) => t.when(({ data }: Ctx) => data.phase === 'settled').target(S.settled))
			)

			.state(S.checking, (s) =>
				s
					.entry((a) =>
						a
							.send(EVENTS.allowlistCheck, (b) =>
								b.to(actorTargetUri(ALLOWLIST_ADDRESS)).data(
									({ data }: Ctx): AllowlistCheckData => ({
										login: data.issue!.author,
										association: data.issue!.association
									})
								)
							)
							.send(EVENTS.checkTimeout, (b) => b.id(CHECK_TIMEOUT_SEND_ID).after(CHECK_TIMEOUT_MS))
					)
					.exit((a) => a.cancel(CHECK_TIMEOUT_SEND_ID))
					.on(EVENTS.allowlistVerdict, (t) =>
						t
							.when((ctx: Ctx) => eventData<AllowlistVerdictData>(ctx).allowed)
							.target(S.allowed)
							.assign('reason', (ctx: Ctx) => eventData<AllowlistVerdictData>(ctx).reason)
					)
					.on(EVENTS.allowlistVerdict, (t) =>
						t.target(S.closing).assign('reason', (ctx: Ctx) => eventData<AllowlistVerdictData>(ctx).reason)
					)
					.on(EVENTS.checkTimeout, (t) => t.target(S.failed).assign('reason', literal(OUTCOME_REASONS.checkTimeout)))
			)

			.state(S.closing, (s) =>
				s
					.entry((a) =>
						a
							.assign('phase', literal('closing'))
							.send(EVENTS.githubClose, (b) => b.via(GITHUB_IO_TYPE).data(closeRequest))
					)
					// Keep the verdict's reason (`not-allowed` or `blocklist`); a closing issue restored
					// from the outbox after a restart has none, so it reports `not-allowed`.
					.on(EVENTS.githubClosed, (t) => t.target(S.closed).assign('reason', ({ data }: Ctx) => data.reason ?? OUTCOME_REASONS.notAllowed))
					.on(EVENTS.githubGaveUp, (t) =>
						t
							.target(S.failed)
							.assign('reason', (ctx: Ctx) => OUTCOME_REASONS.gaveUp(eventData<GitHubGaveUpData>(ctx).lastError))
					)
					// The github I/O processor failed the send (outbox not written).
					.on('error.communication', (t) =>
						t.target(S.failed).assign('reason', (ctx: Ctx) => {
							const d = ctx.event?.data as { error?: unknown } | undefined;
							return OUTCOME_REASONS.gaveUp(`outbox write failed: ${String(d?.error ?? 'unknown error')}`);
						})
					)
			)

			.final(S.allowed, (s) =>
				s.entry((a) => a.assign('verdict', literal('allowed'))).doneData((d) => d.content(doneData('allowed')))
			)
			.final(S.closed, (s) =>
				s.entry((a) => a.assign('verdict', literal('closed'))).doneData((d) => d.content(doneData('closed')))
			)
			.final(S.failed, (s) =>
				s.entry((a) => a.assign('verdict', literal('failed'))).doneData((d) => d.content(doneData('failed')))
			)
			.final(S.settled, (s) =>
				s
					.entry((a) =>
						a.assign('verdict', literal('settled')).assign('reason', literal(OUTCOME_REASONS.alreadySettled))
					)
					.doneData((d) => d.content(doneData('settled')))
			)
	);
}
