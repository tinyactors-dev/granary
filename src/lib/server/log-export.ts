/**
 * Ship granary's log lines to the ops telemetry sinks as OTLP/JSON logs
 * (ADR 0027), so they land in Loki next to traces (Tempo) and metrics.
 *
 * Lines are batched (every FLUSH_MS or MAX_BATCH lines). Lines about the
 * telemetry pipeline itself are not exported, so a failing sink cannot feed
 * its own error loop; the sink's drop-oldest buffer bounds everything else.
 */
import { onLog, type LogLine } from './log';
import type { TelemetrySink } from '$lib/ops/contract';

const FLUSH_MS = 2000;
const MAX_BATCH = 200;
const SELF = /^ops telemetry|telemetry sink|otlp/i;
const SEVERITY = { info: [9, 'INFO'], warn: [13, 'WARN'], error: [17, 'ERROR'] } as const;
const str = (v: string) => ({ stringValue: v });

export function encodeLogLines(lines: LogLine[], service = 'granary'): Uint8Array {
	const doc = {
		resourceLogs: [
			{
				resource: { attributes: [{ key: 'service.name', value: str(service) }] },
				scopeLogs: [
					{
						scope: { name: 'granary.log' },
						logRecords: lines.map((l) => ({
							timeUnixNano: String(BigInt(l.at) * 1_000_000n),
							observedTimeUnixNano: String(BigInt(l.at) * 1_000_000n),
							severityNumber: SEVERITY[l.level][0],
							severityText: SEVERITY[l.level][1],
							body: str(l.details.length ? `${l.message} ${l.details.join(' ')}` : l.message),
							attributes: [{ key: 'log.level', value: str(l.level) }]
						}))
					}
				]
			}
		]
	};
	return new TextEncoder().encode(JSON.stringify(doc));
}

/** Start exporting; returns a stop function that flushes what is pending. */
export function attachLogExport(sink: TelemetrySink): () => void {
	let pending: LogLine[] = [];
	const flush = () => {
		if (pending.length === 0) return;
		const lines = pending;
		pending = [];
		if (sink.active && !sink.active()) return;
		sink.write({ signal: 'logs', contentType: 'application/json', bytes: encodeLogLines(lines), service: 'granary', producedAt: Date.now() });
	};
	const off = onLog((line) => {
		if (SELF.test(line.message)) return;
		pending.push(line);
		if (pending.length >= MAX_BATCH) flush();
	});
	const timer = setInterval(flush, FLUSH_MS);
	(timer as { unref?: () => void }).unref?.();
	return () => {
		off();
		clearInterval(timer);
		flush();
	};
}
