/**
 * Missed-webhook catch-up (ADR 0162, 0194): the `github-app` I/O processor
 * used by `delivery-catchup/main`, and the message catalogue between them.
 *
 * `catchup.list` → walk `GET /app/hook/deliveries` back to the checkpoint
 * (or 72 h) and reply `catchup.listed {candidates, newest}`: failed,
 * non-redelivery deliveries of accepted events whose GUID is neither in the
 * inbox nor delivered successfully later. With no candidates the pass is
 * recorded (and the checkpoint advanced) right away.
 * `catchup.redeliver {ids, newest}` → `POST …/attempts` for each (max 50,
 * 200 ms apart), record the pass, advance the checkpoint only if every
 * attempt was accepted, reply `catchup.redelivered`.
 * Failures reply `catchup.failed {error}`; the actor stays alive.
 */
import type { ActorAddress, IOProcessor } from '@tinyactors/node';
import { Type, type Static } from '@sinclair/typebox';
import { GITHUB_APP_EVENTS, GITHUB_APP_LIFECYCLE_EVENTS } from '../../schemas/github-app';
import { parse } from '../../schemas/standard';
import { log } from '../log';
import type { Wal } from '../wal';
import type { GitHubConnection } from './connection';

export const CATCHUP_IO_TYPE = 'github-app';
export const CATCHUP_FAMILY = 'delivery-catchup';
export const CATCHUP_ADDRESS: ActorAddress = { family: CATCHUP_FAMILY, name: 'main' };

export const CATCHUP_EVENTS = {
	tick: 'catchup.tick',
	runNow: 'catchup.run-now',
	list: 'catchup.list',
	listed: 'catchup.listed',
	redeliver: 'catchup.redeliver',
	redelivered: 'catchup.redelivered',
	failed: 'catchup.failed'
} as const;

export const CATCHUP_WINDOW_MS = 72 * 3_600_000;
export const CATCHUP_MAX_PER_PASS = 50;
const MAX_PAGES = 30;
const ACCEPTED_EVENTS = new Set<string>([...GITHUB_APP_EVENTS, ...GITHUB_APP_LIFECYCLE_EVENTS]);

export const CatchupCandidate = Type.Object({ id: Type.Integer(), guid: Type.String(), event: Type.String() }, { additionalProperties: false });
export type CatchupCandidate = Static<typeof CatchupCandidate>;

export const CatchupListed = Type.Object(
	{ candidates: Type.Array(CatchupCandidate), newest: Type.Union([Type.Number(), Type.Null()]) },
	{ additionalProperties: false }
);
export type CatchupListed = Static<typeof CatchupListed>;

export const CatchupRedeliver = Type.Object(
	{ ids: Type.Array(Type.Integer()), newest: Type.Union([Type.Number(), Type.Null()]) },
	{ additionalProperties: false }
);
export type CatchupRedeliver = Static<typeof CatchupRedeliver>;

export const CatchupRedelivered = Type.Object(
	{ redelivered: Type.Integer(), failed: Type.Integer(), lastError: Type.Union([Type.String(), Type.Null()]) },
	{ additionalProperties: false }
);
export type CatchupRedelivered = Static<typeof CatchupRedelivered>;

export const CatchupFailed = Type.Object({ error: Type.String() }, { additionalProperties: false });
export type CatchupFailed = Static<typeof CatchupFailed>;

export interface CatchupDeps {
	connection: () => GitHubConnection | null;
	wal: Wal;
	/** Spacing between redelivery requests; default 200 ms. */
	spacingMs?: number;
}

const isOk = (code: number) => code >= 200 && code < 300;

export async function listCandidates(conn: GitHubConnection, wal: Wal, now = Date.now()): Promise<CatchupListed> {
	const floor = Math.max(now - CATCHUP_WINDOW_MS, conn.checkpoint() ?? 0);
	const failed = new Map<string, CatchupCandidate>();
	const succeeded = new Set<string>();
	let newest: number | null = null;
	let path: string | null = '/app/hook/deliveries?per_page=100';
	for (let page = 0; path && page < MAX_PAGES; page++) {
		const { items, next } = await conn.hookDeliveries(path);
		let reachedFloor = false;
		for (const d of items) {
			const at = Date.parse(d.delivered_at);
			if (!Number.isNaN(at) && at < floor) {
				reachedFloor = true;
				continue;
			}
			if (!Number.isNaN(at)) newest = newest === null ? at : Math.max(newest, at);
			if (isOk(d.status_code)) {
				succeeded.add(d.guid);
				continue;
			}
			if (d.redelivery || !ACCEPTED_EVENTS.has(d.event) || failed.has(d.guid)) continue;
			failed.set(d.guid, { id: d.id, guid: d.guid, event: d.event });
		}
		path = reachedFloor ? null : next;
	}
	const candidates = [...failed.values()]
		.filter((c) => !succeeded.has(c.guid) && wal.getInbox(c.guid) === null)
		.slice(0, CATCHUP_MAX_PER_PASS);
	return { candidates, newest };
}

export function catchupProcessor(deps: CatchupDeps): IOProcessor {
	const spacing = deps.spacingMs ?? 200;
	return {
		async send(request, ctx) {
			const source = request.source;
			if (!('family' in source)) throw new Error('github-app processor: the sender must be a named actor');
			const replyTo: ActorAddress = { family: source.family, name: source.name };
			const conn = deps.connection();
			const fail = (error: string) => {
				log.warn(`catch-up: ${error}`, { 'catchup.outcome': 'failed', 'error.message': error });
				conn?.recordCatchupPass({ at: Date.now(), redelivered: 0, error });
				ctx.post(replyTo, CATCHUP_EVENTS.failed, { error } satisfies CatchupFailed);
			};
			if (!conn || conn.mode() !== 'app') return fail('GitHub App mode is not active');

			if (request.event === CATCHUP_EVENTS.list) {
				try {
					const listed = await listCandidates(conn, deps.wal);
					if (listed.candidates.length === 0) {
						conn.recordCatchupPass({ at: Date.now(), redelivered: 0, error: null });
						log.info('catch-up: pass done, no missed webhooks', { 'catchup.outcome': 'ok', 'catchup.missed': 0, 'catchup.redelivered': 0 });
						if (listed.newest !== null) conn.setCheckpoint(listed.newest);
					}
					ctx.post(replyTo, CATCHUP_EVENTS.listed, listed);
				} catch (e) {
					fail(`listing deliveries failed: ${(e as Error).message}`);
				}
				return;
			}

			if (request.event === CATCHUP_EVENTS.redeliver) {
				let input: CatchupRedeliver;
				try {
					input = parse(CatchupRedeliver, request.data, 'catchup.redeliver');
				} catch (e) {
					return fail((e as Error).message);
				}
				let redelivered = 0;
				let failed = 0;
				let lastError: string | null = null;
				for (const [i, id] of input.ids.slice(0, CATCHUP_MAX_PER_PASS).entries()) {
					if (i > 0 && spacing > 0) await Bun.sleep(spacing);
					try {
						await conn.redeliver(id);
						redelivered++;
					} catch (e) {
						failed++;
						lastError = `delivery ${id}: ${(e as Error).message}`.slice(0, 300);
					}
				}
				conn.recordCatchupPass({ at: Date.now(), redelivered, error: lastError });
				if (failed === 0 && input.newest !== null) conn.setCheckpoint(input.newest);
				(failed ? log.warn : log.info)(`catch-up: pass done, asked GitHub to redeliver ${redelivered} of ${input.ids.length} missed webhook(s)`, {
					'catchup.outcome': failed ? 'partial' : 'ok',
					'catchup.missed': input.ids.length,
					'catchup.redelivered': redelivered,
					'catchup.failed': failed,
					'error.message': lastError ?? undefined
				});
				ctx.post(replyTo, CATCHUP_EVENTS.redelivered, { redelivered, failed, lastError } satisfies CatchupRedelivered);
				return;
			}

			throw new Error(`github-app processor: unsupported event ${request.event}`);
		}
	};
}
