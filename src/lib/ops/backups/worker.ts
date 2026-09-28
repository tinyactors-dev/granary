/**
 * Client for the snapshot Worker (ADR 0083): heavy SQLite work (VACUUM INTO,
 * integrity_check, row counts, sha256) runs off the JS thread. One Worker,
 * jobs serialised; a crashed Worker is replaced and its job fails with
 * `worker-crashed`.
 */
import { SNAPSHOT_WORKER_SOURCE } from '../io/snapshot.worker';

export interface DbFacts {
	sqliteVersion: string;
	userVersion: number;
	pageCount: number;
	rowCounts: Record<string, number>;
	rawBytes: number;
	rawSha256?: string;
}

export type WorkerReply = { ok: true; facts: DbFacts } | { ok: false; reason: 'disk-insufficient' | 'integrity' | 'sqlite-error' | 'worker-crashed'; detail: string };

type Job = { type: 'snapshot'; dbPath: string; outPath: string } | { type: 'check'; path: string };

export class SnapshotWorker {
	#worker: Worker | null = null;
	#url: string | null = null;
	#seq = 0;
	#pending = new Map<number, (r: WorkerReply) => void>();
	#queue: Promise<unknown> = Promise.resolve();

	#ensure(): Worker {
		if (this.#worker) return this.#worker;
		this.#url ??= URL.createObjectURL(new Blob([SNAPSHOT_WORKER_SOURCE], { type: 'application/javascript' }));
		const w = new Worker(this.#url);
		w.onmessage = (e: MessageEvent) => {
			const { id, ...reply } = e.data as { id: number } & WorkerReply;
			this.#pending.get(id)?.(reply as WorkerReply);
			this.#pending.delete(id);
		};
		const crash = (detail: string) => {
			for (const [, resolve] of this.#pending) resolve({ ok: false, reason: 'worker-crashed', detail });
			this.#pending.clear();
			this.#worker = null;
		};
		w.onerror = (e) => crash(`snapshot worker error: ${(e as ErrorEvent).message ?? String(e)}`);
		w.addEventListener('close', () => crash('snapshot worker exited'));
		// Don't keep the process alive just for an idle worker.
		(w as unknown as { unref?: () => void }).unref?.();
		this.#worker = w;
		return w;
	}

	run(job: Job): Promise<WorkerReply> {
		const next = this.#queue.then(
			() =>
				new Promise<WorkerReply>((resolve) => {
					const id = ++this.#seq;
					this.#pending.set(id, resolve);
					try {
						this.#ensure().postMessage({ id, ...job });
					} catch (e) {
						this.#pending.delete(id);
						resolve({ ok: false, reason: 'worker-crashed', detail: String(e) });
					}
				})
		);
		this.#queue = next.catch(() => undefined);
		return next;
	}

	snapshot(dbPath: string, outPath: string): Promise<WorkerReply> {
		return this.run({ type: 'snapshot', dbPath, outPath });
	}

	check(path: string): Promise<WorkerReply> {
		return this.run({ type: 'check', path });
	}

	terminate(): void {
		this.#worker?.terminate();
		this.#worker = null;
		if (this.#url) URL.revokeObjectURL(this.#url);
		this.#url = null;
	}
}
