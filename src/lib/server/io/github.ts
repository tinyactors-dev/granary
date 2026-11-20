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
 */
import type { IOProcessor } from '@tinyactors/node';
import {
	EVENTS,
	FAMILY,
	GITHUB_IO_TYPE,
	closeEffectKey,
	issueKey,
	parseEventData,
	type ActorAddress,
	type GitHubClosedData,
	type GitHubGaveUpData
} from '../../schemas/actors';
import type { Wal } from '../wal';
import { renderClosingBody } from '../closing-messages';
import { log } from '../log';

export { GITHUB_IO_TYPE };

export interface GitHubProcessorDeps {
	wal: Wal;
	/** Called after a new or pending row was committed. */
	kickRelay: () => void;
}

export function githubProcessor(deps: GitHubProcessorDeps): IOProcessor {
	return {
		receive(send) {
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
