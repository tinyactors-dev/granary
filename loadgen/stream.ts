/**
 * Subscribe to the fake GitHub's SSE event stream (ADR 0075), reconnecting
 * from the last seen sequence number.
 */
import { FakeEvent } from '../fake-github/schemas';
import { check } from '../src/lib/schemas/standard';
import { CONTROL_PATHS } from '../fake-github/schemas';

export interface StreamStatus {
	connected: boolean;
	lastSeq: number;
	error: string | null;
}

export function subscribeEvents(
	base: string,
	since: number,
	onEvent: (e: FakeEvent) => void,
	log: (msg: string) => void = () => {}
): { status: StreamStatus; close(): void } {
	const status: StreamStatus = { connected: false, lastSeq: since, error: null };
	let closed = false;
	let controller: AbortController | null = null;

	async function run() {
		let backoff = 250;
		while (!closed) {
			controller = new AbortController();
			try {
				const res = await fetch(`${base}${CONTROL_PATHS.events}?since=${status.lastSeq}`, {
					headers: { Accept: 'text/event-stream' },
					signal: controller.signal
				});
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				status.connected = true;
				status.error = null;
				backoff = 250;
				const decoder = new TextDecoder();
				let buffer = '';
				for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
					buffer += decoder.decode(chunk, { stream: true });
					let idx: number;
					while ((idx = buffer.indexOf('\n\n')) >= 0) {
						const frame = buffer.slice(0, idx);
						buffer = buffer.slice(idx + 2);
						const data = frame
							.split('\n')
							.filter((l) => l.startsWith('data: '))
							.map((l) => l.slice(6))
							.join('\n');
						if (!data) continue;
						let parsed: unknown;
						try {
							parsed = JSON.parse(data);
						} catch {
							continue;
						}
						if (!check(FakeEvent, parsed)) {
							log(`ignoring malformed fake GitHub event: ${data.slice(0, 200)}`);
							continue;
						}
						if (parsed.seq <= status.lastSeq) continue;
						status.lastSeq = parsed.seq;
						try {
							onEvent(parsed);
						} catch (e) {
							log(`event handler failed: ${(e as Error).stack ?? e}`);
						}
					}
				}
				throw new Error('stream ended');
			} catch (e) {
				status.connected = false;
				if (closed) return;
				status.error = (e as Error).message;
				await Bun.sleep(backoff);
				backoff = Math.min(backoff * 2, 5000);
			}
		}
	}
	void run();
	return {
		status,
		close() {
			closed = true;
			controller?.abort();
		}
	};
}
