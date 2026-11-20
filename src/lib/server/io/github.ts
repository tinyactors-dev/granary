/**
 * The durable `github` I/O processor (ADR 0002, ADR 0003, ADR 0033).
 *
 * `<send type="github" event="github.close">` from an issue actor runs
 * `receive()` between the host's runs (so synchronous `bun:sqlite` is safe):
 * - validate the data (`GitHubCloseData`);
 * - render the closing comment from the templates in effect now (ADR 0251);
 * - `INSERT OR IGNORE` the outbox row `close:<repoId>:<number>` with
 *   `reply_to` = the issue actor's address (`issue/<repoId>-<number>`), and commit;
 * - row already `done` → reply `github.closed` at once; already `dead` →
 *   reply `github.gave-up` at once; otherwise kick the relay, which replies
 *   later.
 * Bad data fails the send: the actor gets `error.communication`.
 *
 * `github.approve` from an introduction actor (ADR 0310) writes the
 * `approve:<repoId>:<number>` effect; see `receiveApprove`.
 */
import type { IOProcessor } from '@tinyactors/node';
import {
	EVENTS,
	FAMILY,
	GITHUB_IO_TYPE,
	approveEffectKey,
	closeEffectKey,
	issueKey,
	parseEventData,
	type ActorAddress,
	type GitHubApprovedData,
	type GitHubClosedData,
	type GitHubGaveUpData
} from '../../schemas/actors';
import { isApprovePayload, parseOutboxPayload, type ApproveEffectPayload } from '../../schemas/wal';
import { renderApprovedReply } from '../introductions';
import type { Wal } from '../wal';
import { renderClosingBody } from '../closing-messages';
import { log } from '../log';

export { GITHUB_IO_TYPE };

export interface GitHubProcessorDeps {
	wal: Wal;
	/** Called after a new or pending row was committed. */
	kickRelay: () => void;
	/** Called after an approval added an allowlist entry (ADR 0310): post `allowlist.replace`. */
	allowlistChanged: () => void;
}

type Send = Parameters<IOProcessor['receive']>[0];

/**
 * `github.approve` (ADR 0310): in one transaction, allowlist the author for
 * the introduction's scope, collect the items granary closed on them there,
 * render the reply, write the `approve:<repoId>:<number>` effect and mark the
 * introduction `approving`. An effect that exists already is answered from
 * its state (a dead one is retried: approving again is how an admin retries).
 */
function receiveApprove(deps: GitHubProcessorDeps, send: Send): void {
	let data;
	try {
		data = parseEventData(EVENTS.githubApprove, send.data);
	} catch (e) {
		log.error(`github processor: ${(e as Error).message}`);
		send.fail();
		return;
	}
	const intro = deps.wal.getIntroduction(data.introKey);
	if (!intro) {
		log.error(`github processor: unknown introduction ${data.introKey}`);
		send.fail();
		return;
	}
	const effectKey = approveEffectKey(intro.repo_id, intro.number);
	const replyTo: ActorAddress = { family: FAMILY.introduction, name: intro.intro_key };
	const existing = deps.wal.getOutbox(effectKey);
	if (existing) {
		const payload = parseOutboxPayload(existing.payload);
		const reopened = isApprovePayload(payload) ? payload.reopen.length : 0;
		if (existing.state === 'done') {
			send.answer(EVENTS.githubApproved, { effectKey, commentId: existing.comment_id, reopened } satisfies GitHubApprovedData);
			return;
		}
		if (existing.state === 'dead') {
			deps.wal.retryOutbox(effectKey);
			log.info(`outbox: ${effectKey} retried by approving again (${data.by})`, { 'audit.action': 'effect.retry', 'audit.subject': effectKey, 'audit.actor': data.by });
		}
		deps.kickRelay();
		return;
	}
	if (intro.state !== 'pending' && intro.state !== 'approving' && intro.state !== 'failed') {
		log.warn(`github processor: introduction ${intro.intro_key} is ${intro.state}; not approved again`);
		send.fail();
		return;
	}
	const payload: ApproveEffectPayload = deps.wal.tx(() => {
		const { added } = deps.wal.addAllowedUser(intro.author, data.by, { scope: intro.scope, note: `introduction ${intro.owner}/${intro.repo}#${intro.number}` });
		if (added) log.info(`allowlist: ${intro.author} (${intro.scope}) added by ${data.by} (introduction ${intro.intro_key})`, { 'audit.action': 'allowlist.add', 'audit.subject': `${intro.author} (${intro.scope})`, 'audit.actor': data.by });
		const reopen = deps.wal.closedItemsOf(intro.author, intro.scope);
		const p: ApproveEffectPayload = {
			effect: 'approve',
			introKey: intro.intro_key,
			repoId: intro.repo_id,
			owner: intro.owner,
			repo: intro.repo,
			number: intro.number,
			nodeId: intro.node_id,
			author: intro.author,
			title: intro.title,
			htmlUrl: intro.html_url,
			scope: intro.scope,
			by: data.by,
			reopen,
			replyBody: renderApprovedReply(deps.wal.db, { author: intro.author, scope: intro.scope, owner: intro.owner, repo: intro.repo, url: intro.html_url, reopened: reopen })
		};
		deps.wal.insertOutbox({ effectKey, issueKey: intro.intro_key, replyTo, payload: p });
		deps.wal.markIntroductionApproving(intro.intro_key, data.by);
		return p;
	});
	log.info(`outbox: ${effectKey} queued for ${replyTo.family}/${replyTo.name} (reopen ${payload.reopen.length})`, { 'audit.action': 'introduction.approve', 'audit.subject': intro.intro_key, 'audit.actor': data.by });
	deps.allowlistChanged();
	deps.kickRelay();
}

export function githubProcessor(deps: GitHubProcessorDeps): IOProcessor {
	return {
		receive(send) {
			if (send.event === EVENTS.githubApprove) return receiveApprove(deps, send);
			let data;
			try {
				if (send.event !== EVENTS.githubClose) throw new Error(`unsupported event ${send.event}`);
				data = parseEventData(EVENTS.githubClose, send.data);
			} catch (e) {
				log.error(`github processor: ${(e as Error).message}`);
				send.fail();
				return;
			}
			// The relay answers the issue by its name, which survives a restart (a session does not).
			const replyTo: ActorAddress = { family: FAMILY.issue, name: issueKey(data.repoId, data.number) };
			const effectKey = closeEffectKey(data.repoId, data.number);
			const { inserted, row } = deps.wal.insertOutbox({
				effectKey,
				issueKey: replyTo.name,
				replyTo,
				payload: { ...data, commentBody: renderClosingBody(deps.wal.db, data) }
			});
			if (row.state === 'done') {
				send.answer(EVENTS.githubClosed, { effectKey, commentId: row.comment_id } satisfies GitHubClosedData);
				return;
			}
			if (row.state === 'dead') {
				send.answer(EVENTS.githubGaveUp, {
					effectKey,
					attempts: row.attempts,
					lastError: row.last_error ?? 'dead'
				} satisfies GitHubGaveUpData);
				return;
			}
			if (inserted) log.info(`outbox: ${effectKey} queued for ${replyTo.family}/${replyTo.name}`);
			deps.kickRelay();
		}
	};
}
