/**
 * The durable `github` I/O processor (ADR 0002, ADR 0003, ADR 0033).
 *
 * `<send type="github" event="github.close">` from an issue actor runs
 * `send()` at the end of the pump turn (so synchronous `bun:sqlite` is safe):
 * - validate the data (`GitHubCloseData`);
 * - render the closing comment from the templates in effect now (ADR 0251);
 * - `INSERT OR IGNORE` the outbox row `close:<repoId>:<number>` with
 *   `reply_to` = the sending actor's address, and commit;
 * - row already `done` → reply `github.closed` at once; already `dead` →
 *   reply `github.gave-up` at once; otherwise kick the relay, which replies
 *   later.
 * Throwing fails the send: the actor gets `error.communication`.
 */
import type { ActorAddress as TaActorAddress, IOProcessor } from '@tinyactors/node';
import {
	EVENTS,
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

function isAddress(x: unknown): x is TaActorAddress {
	return typeof x === 'object' && x !== null && typeof (x as TaActorAddress).family === 'string' && typeof (x as TaActorAddress).name === 'string';
}

export function githubProcessor(deps: GitHubProcessorDeps): IOProcessor {
	return {
		send(request, ctx) {
			if (request.event !== EVENTS.githubClose) {
				throw new Error(`github processor: unsupported event ${request.event}`);
			}
			if (!isAddress(request.source)) {
				throw new Error('github processor: the sender must be a named actor');
			}
			const replyTo: ActorAddress = { family: request.source.family, name: request.source.name };
			const data = parseEventData(EVENTS.githubClose, request.data);
			const effectKey = closeEffectKey(data.repoId, data.number);
			const { inserted, row } = deps.wal.insertOutbox({
				effectKey,
				issueKey: issueKey(data.repoId, data.number),
				replyTo,
				payload: { ...data, commentBody: renderClosingBody(deps.wal.db, data) }
			});
			if (row.state === 'done') {
				ctx.post(replyTo, EVENTS.githubClosed, { effectKey, commentId: row.comment_id } satisfies GitHubClosedData);
				return;
			}
			if (row.state === 'dead') {
				ctx.post(replyTo, EVENTS.githubGaveUp, {
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
