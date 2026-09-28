/**
 * Request log, counters and the SSE event stream of fake-infra (ADR 0136).
 * Observation only, not domain state — kept outside the actors like
 * fake-github's EventLog.
 */
import type { Static } from '@sinclair/typebox';
import type { FakeInfraEvent, FakeRequestLog } from './schemas';

export type RequestLog = Static<typeof FakeRequestLog>;
type Event = FakeInfraEvent & { seq?: number };

const MAX_REQUESTS = 1000;

export class InfraLog {
	requests: RequestLog[] = [];
	counters = { s3Puts: 0, s3Deletes: 0, s3BytesIn: 0, otlpBatches: 0 };
	#seq = 0;
	#listeners = new Set<(e: Event, seq: number) => void>();

	request(r: RequestLog, kind: { put?: boolean; delete?: boolean } = {}): void {
		this.requests.push(r);
		if (this.requests.length > MAX_REQUESTS) this.requests.splice(0, this.requests.length - MAX_REQUESTS);
		if (r.surface === 's3' && r.status < 400) {
			if (kind.put) this.counters.s3Puts += 1;
			if (kind.delete) this.counters.s3Deletes += 1;
			this.counters.s3BytesIn += r.bytesIn;
		}
		this.emit({ type: 's3.request', request: r });
	}

	emit(e: FakeInfraEvent): void {
		const seq = ++this.#seq;
		if (e.type === 'otlp.batch') this.counters.otlpBatches += 1;
		for (const l of this.#listeners) {
			try {
				l(e, seq);
			} catch {
				/* a broken subscriber must not break the fake */
			}
		}
	}

	reset(): void {
		this.requests = [];
		this.counters = { s3Puts: 0, s3Deletes: 0, s3BytesIn: 0, otlpBatches: 0 };
		this.emit({ type: 'reset' });
	}

	/** SSE: live events only (state is in GET /__control/state). */
	stream(signal: AbortSignal): Response {
		const encoder = new TextEncoder();
		let off = () => {};
		let ping: ReturnType<typeof setInterval> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start: (c) => {
				const send = (e: Event, seq: number) => {
					try {
						c.enqueue(encoder.encode(`id: ${seq}\ndata: ${JSON.stringify(e)}\n\n`));
					} catch {
						off();
					}
				};
				c.enqueue(encoder.encode(`retry: 1000\n: connected\n\n`));
				this.#listeners.add(send);
				off = () => this.#listeners.delete(send);
				ping = setInterval(() => {
					try {
						c.enqueue(encoder.encode(': ping\n\n'));
					} catch {
						/* closed */
					}
				}, 15_000);
				signal.addEventListener('abort', () => {
					off();
					clearInterval(ping);
					try {
						c.close();
					} catch {
						/* closed */
					}
				});
			},
			cancel: () => {
				off();
				clearInterval(ping);
			}
		});
		return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
	}
}
