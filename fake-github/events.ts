/**
 * The fake GitHub's event log (ADR 0075): an in-memory, sequence-numbered
 * ring of what happened, served as SSE and as JSON pages. Not an actor —
 * it is the host's notification side-channel, like GitHub's own event feed.
 */
import type { FakeEvent, FakeEventInput } from './schemas';

const MAX_EVENTS = 20_000;

type Listener = (e: FakeEvent) => void;

export class EventLog {
	#events: FakeEvent[] = [];
	#seq = 0;
	#listeners = new Set<Listener>();

	get lastSeq(): number {
		return this.#seq;
	}

	emit(input: FakeEventInput): FakeEvent {
		const event = { ...input, seq: ++this.#seq, at: Date.now() } as FakeEvent;
		this.#events.push(event);
		if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
		for (const l of this.#listeners) {
			try {
				l(event);
			} catch {
				/* a broken subscriber must not break the fake */
			}
		}
		return event;
	}

	since(seq: number, limit = 1000): FakeEvent[] {
		const out: FakeEvent[] = [];
		for (const e of this.#events) {
			if (e.seq <= seq) continue;
			out.push(e);
			if (out.length >= limit) break;
		}
		return out;
	}

	subscribe(l: Listener): () => void {
		this.#listeners.add(l);
		return () => this.#listeners.delete(l);
	}

	/** SSE response: replay everything after `since`, then stream live events. */
	stream(since: number, signal: AbortSignal): Response {
		const encoder = new TextEncoder();
		let unsubscribe = () => {};
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const send = (e: FakeEvent) => {
					try {
						controller.enqueue(encoder.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
					} catch {
						unsubscribe();
					}
				};
				controller.enqueue(encoder.encode(`retry: 1000\n: connected ${this.#seq}\n\n`));
				let cursor = since;
				for (;;) {
					const batch = this.since(cursor, 5000);
					if (!batch.length) break;
					for (const e of batch) send(e);
					cursor = batch[batch.length - 1]!.seq;
				}
				unsubscribe = this.subscribe((e) => {
					if (e.seq > cursor) send(e);
				});
				heartbeat = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(`: ping\n\n`));
					} catch {
						/* closed */
					}
				}, 15_000);
				signal.addEventListener('abort', () => {
					unsubscribe();
					clearInterval(heartbeat);
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				});
			},
			cancel: () => {
				unsubscribe();
				clearInterval(heartbeat);
			}
		});
		return new Response(body, {
			headers: {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive'
			}
		});
	}
}
