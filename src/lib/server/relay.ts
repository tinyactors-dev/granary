/**
 * The outbox relay (ADR 0002, ADR 0003, ADR 0041). Plain async TypeScript,
 * not an actor.
 *
 * For each due `pending` outbox row (claimed → `inflight`, `attempts + 1`,
 * committed before any GitHub call):
 *   1. if `comment_id` is null: on a retry (an earlier attempt exists) look
 *      for an existing comment carrying `<!-- granary:<effect_key> -->`;
 *      otherwise / if none, POST the closing comment with that marker.
 *      Store `comment_id`.
 *   2. PATCH the issue `state=closed, state_reason=not_planned`, or for a
 *      pull request `PATCH …/pulls/{n}` `state=closed` (idempotent, ADR 0280).
 *   3. mark the row `done`, then `system.post(reply_to, 'github.closed', …)`.
 * On failure: `pending` again with exponential backoff (or `Retry-After`),
 * or after MAX_EFFECT_ATTEMPTS `dead` + `github.gave-up` to `reply_to`.
 * At most `concurrency` effects run at once.
 */
import type { System } from '@tinyactors/node';
import { EVENTS, MAX_EFFECT_ATTEMPTS, type GitHubClosedData, type GitHubGaveUpData } from '../schemas/actors';
import { commentMarker } from '../schemas/github';
import { commentWithMarker, renderClosingBody } from './closing-messages';
import { parseOutboxPayload, parseReplyTo, type OutboxPayload, type OutboxRow } from '../schemas/wal';
import { GitHubHttpError, type GitHubClient } from './github-client';
import { log } from './log';
import type { Wal } from './wal';

/** A fixed client, or one resolved per effect (app mode: the repo's installation token, ADR 0191). */
export type RelayGitHub = GitHubClient | ((payload: OutboxPayload) => Promise<GitHubClient>);

export interface RelayOptions {
	wal: Wal;
	github: RelayGitHub;
	system: System;
	/** Max effects in flight; default 4. */
	concurrency?: number;
	/** First retry delay; doubles per attempt. Default 1000 ms. */
	baseDelayMs?: number;
	/** Cap on a single retry delay; default 5 min. */
	maxDelayMs?: number;
	maxAttempts?: number;
}

export class Relay {
	readonly #wal: Wal;
	readonly #github: RelayGitHub;
	readonly #system: System;
	readonly #concurrency: number;
	readonly #baseDelayMs: number;
	readonly #maxDelayMs: number;
	readonly #maxAttempts: number;
	#inflight = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | null = null;
	#timerAt = 0;
	#scheduled = false;
	#stopped = false;
	#abort = new AbortController();
	#running = new Set<Promise<void>>();

	constructor(opts: RelayOptions) {
		this.#wal = opts.wal;
		this.#github = opts.github;
		this.#system = opts.system;
		this.#concurrency = Math.max(1, opts.concurrency ?? 4);
		this.#baseDelayMs = opts.baseDelayMs ?? 1000;
		this.#maxDelayMs = opts.maxDelayMs ?? 5 * 60_000;
		this.#maxAttempts = opts.maxAttempts ?? MAX_EFFECT_ATTEMPTS;
	}

	/** Boot: crash recovery (`inflight` → `pending`) and a first pass. */
	start(): void {
		const n = this.#wal.resetInflight();
		if (n) log.info(`relay: ${n} inflight effect(s) from a previous run reset to pending`);
		this.kick();
	}

	/** Look for due rows soon (coalesced). */
	kick(): void {
		if (this.#stopped || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.#pump();
		});
	}

	/** Stop claiming; wait up to `graceMs` for running effects. */
	async stop(graceMs = 5000): Promise<void> {
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		const all = Promise.allSettled([...this.#running]);
		const grace = new Promise((r) => setTimeout(r, graceMs).unref?.());
		await Promise.race([all, grace]);
		this.#abort.abort();
	}

	get inflightCount(): number {
		return this.#inflight.size;
	}

	#pump(): void {
		if (this.#stopped) return;
		let rows: OutboxRow[];
		try {
			rows = this.#wal.claimDue(this.#concurrency - this.#inflight.size);
		} catch (e) {
			log.error('relay: claiming due effects failed', e);
			this.#armTimer(Date.now() + 5000);
			return;
		}
		for (const row of rows) {
			this.#inflight.add(row.effect_key);
			const p = this.#run(row).finally(() => {
				this.#inflight.delete(row.effect_key);
				this.#running.delete(p);
				this.kick();
			});
			this.#running.add(p);
		}
		if (this.#inflight.size < this.#concurrency) {
			const next = this.#wal.nextOutboxDueAt();
			if (next !== null) this.#armTimer(next);
		}
	}

	#armTimer(at: number): void {
		if (this.#stopped) return;
		if (this.#timer && this.#timerAt <= at) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timerAt = at;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#pump();
		}, Math.max(0, at - Date.now()));
		this.#timer.unref?.();
	}

	async #run(row: OutboxRow): Promise<void> {
		const key = row.effect_key;
		let replyTo;
		let payload;
		try {
			replyTo = parseReplyTo(row.reply_to);
			payload = parseOutboxPayload(row.payload);
		} catch (e) {
			// A corrupt row can never succeed: dead, and nobody to tell reliably.
			log.error(`relay: ${key} has an invalid row`, e);
			this.#wal.markOutboxDead(key, `invalid row: ${(e as Error).message}`);
			return;
		}
		const signal = this.#abort.signal;
		try {
			const github = typeof this.#github === 'function' ? await this.#github(payload) : this.#github;
			let commentId = row.comment_id;
			if (commentId === null) {
				const marker = commentMarker(key);
				if (row.attempts > 1) {
					const comments = await github.listComments(payload.owner, payload.repo, payload.number, signal);
					commentId = comments.find((c) => c.body.includes(marker))?.id ?? null;
					if (commentId !== null) this.#wal.setCommentId(key, commentId);
				}
				if (commentId === null) {
					const comment = await github.createComment(
						payload.owner,
						payload.repo,
						payload.number,
						commentWithMarker(payload.commentBody ?? renderClosingBody(this.#wal.db, payload), marker),
						signal
					);
					commentId = comment.id;
					this.#wal.setCommentId(key, commentId);
				}
			}
			if (payload.kind === 'pull_request') await github.closePullRequest(payload.owner, payload.repo, payload.number, signal);
			else await github.closeIssue(payload.owner, payload.repo, payload.number, signal);
			this.#wal.markOutboxDone(key);
			log.info(`relay: ${key} done (comment ${commentId}, attempt ${row.attempts})`, { 'relay.effect_key': key, 'github.repository': `${payload.owner}/${payload.repo}`, 'github.issue.number': payload.number, 'github.comment_id': commentId ?? undefined, 'relay.attempts': row.attempts });
			this.#reply(replyTo, EVENTS.githubClosed, { effectKey: key, commentId } satisfies GitHubClosedData);
		} catch (e) {
			if (this.#stopped && signal.aborted) {
				// Shutting down: leave it for the next boot (inflight → pending).
				return;
			}
			const message = e instanceof Error ? e.message : String(e);
			if (row.attempts >= this.#maxAttempts) {
				this.#wal.markOutboxDead(key, message);
				log.error(`relay: ${key} gave up after ${row.attempts} attempts: ${message}`, { 'relay.effect_key': key, 'github.repository': `${payload.owner}/${payload.repo}`, 'github.issue.number': payload.number, 'relay.attempts': row.attempts, 'error.message': message });
				this.#reply(replyTo, EVENTS.githubGaveUp, {
					effectKey: key,
					attempts: row.attempts,
					lastError: message
				} satisfies GitHubGaveUpData);
				return;
			}
			const retryAfter = e instanceof GitHubHttpError ? e.retryAfterMs : null;
			const backoff = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (row.attempts - 1));
			const jitter = Math.floor(Math.random() * Math.min(250, backoff / 4));
			const delay = retryAfter !== null ? Math.max(retryAfter, 0) : backoff + jitter;
			const next = Date.now() + delay;
			this.#wal.markOutboxRetry(key, next, message);
			log.warn(`relay: ${key} attempt ${row.attempts} failed, retry in ${delay} ms: ${message}`, { 'relay.effect_key': key, 'github.repository': `${payload.owner}/${payload.repo}`, 'github.issue.number': payload.number, 'relay.attempts': row.attempts, 'relay.retry_in_ms': delay, 'http.response.status_code': e instanceof GitHubHttpError ? e.status : undefined, 'error.message': message });
			this.#armTimer(next);
		}
	}

	#reply(to: { family: string; name: string }, event: string, data: unknown): void {
		try {
			this.#system.post(to, event, data);
		} catch (e) {
			// queue-full / closed: the actor is restored in `closing` on the next
			// issue.opened (sweeper) and the processor answers from the done row.
			log.error(`relay: could not post ${event} to ${to.family}/${to.name}`, e);
		}
	}
}
