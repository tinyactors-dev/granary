/**
 * granary's `OpsHost.health()` provider (ADR 0080, 0100, 0124): cheap,
 * synchronous, never throws. Reads the WAL (outbox/inbox), the actor system
 * (quarantined actors) and process numbers (event-loop lag, RSS).
 */
import type { HostHealthSnapshot } from '$lib/ops/contract';
import type { Runtime } from './system';

/** Event-loop lag sampler: a 500 ms timer measuring its own drift. */
export class LoopLag {
	#samples: number[] = [];
	#timer: ReturnType<typeof setInterval>;
	#expected: number;
	static readonly INTERVAL_MS = 500;
	static readonly WINDOW = 240; // 2 minutes

	constructor() {
		this.#expected = performance.now() + LoopLag.INTERVAL_MS;
		this.#timer = setInterval(() => {
			const now = performance.now();
			this.#samples.push(Math.max(0, now - this.#expected));
			if (this.#samples.length > LoopLag.WINDOW) this.#samples.shift();
			this.#expected = now + LoopLag.INTERVAL_MS;
		}, LoopLag.INTERVAL_MS);
		this.#timer.unref?.();
	}

	p99(): number {
		if (!this.#samples.length) return 0;
		const sorted = [...this.#samples].sort((a, b) => a - b);
		return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]! * 10) / 10;
	}

	stop(): void {
		clearInterval(this.#timer);
	}
}

const QUARANTINE_CACHE_MS = 10_000;

export function createHostHealth(rt: Runtime): { health(): HostHealthSnapshot; stop(): void } {
	const lag = new LoopLag();
	let quarantined = { at: 0, n: 0 };
	const db = rt.wal.db;
	const q = {
		outbox: db.prepare(`SELECT state, COUNT(*) AS n FROM outbox GROUP BY state`),
		oldestOutbox: db.prepare(
			`SELECT MIN(COALESCE(i.received_at, o.updated_at)) AS t FROM outbox o
			 LEFT JOIN inbox i ON i.delivery_id = json_extract(o.payload, '$.deliveryId')
			 WHERE o.state IN ('pending', 'inflight')`
		),
		inboxPending: db.prepare(`SELECT COUNT(*) AS n, MIN(received_at) AS t FROM inbox WHERE state = 'pending'`),
		relayLast: db.prepare(`SELECT MAX(updated_at) AS t FROM outbox WHERE state = 'done'`),
		lastWebhook: db.prepare(`SELECT MAX(received_at) AS t FROM inbox`)
	};

	const countQuarantined = (): number => {
		const now = Date.now();
		if (now - quarantined.at < QUARANTINE_CACHE_MS) return quarantined.n;
		let n = 0;
		try {
			for (const i of rt.system.actors()) if (i.scheduling === 'quarantined') n++;
		} catch {
			/* system closing */
		}
		quarantined = { at: now, n };
		return n;
	};

	return {
		health(): HostHealthSnapshot {
			const at = Date.now();
			const outbox = { pending: 0, inflight: 0, dead: 0, oldestPendingAgeMs: null as number | null };
			const inbox = { pending: 0, oldestPendingAgeMs: null as number | null };
			let relayLastSuccessAt: number | null = null;
			let lastWebhookAt: number | null = null;
			try {
				for (const r of q.outbox.all() as { state: string; n: number }[]) {
					if (r.state === 'pending' || r.state === 'inflight' || r.state === 'dead') outbox[r.state] = r.n;
				}
				const oldest = (q.oldestOutbox.get() as { t: number | null }).t;
				outbox.oldestPendingAgeMs = oldest === null ? null : Math.max(0, at - oldest);
				const ib = q.inboxPending.get() as { n: number; t: number | null };
				inbox.pending = ib.n;
				inbox.oldestPendingAgeMs = ib.t === null ? null : Math.max(0, at - ib.t);
				relayLastSuccessAt = (q.relayLast.get() as { t: number | null }).t;
				lastWebhookAt = (q.lastWebhook.get() as { t: number | null }).t;
			} catch {
				/* database closing: report what we have */
			}
			return {
				at,
				outbox,
				inbox,
				deadLettersTotal: rt.stats.deadLetters,
				quarantinedActors: countQuarantined(),
				relayLastSuccessAt,
				lastWebhookAt,
				process: { eventLoopLagP99Ms: lag.p99(), rssBytes: process.memoryUsage().rss }
			};
		},
		stop() {
			lag.stop();
			for (const s of Object.values(q)) s.finalize();
		}
	};
}
