/**
 * Ship log records to the ops telemetry sinks as OTLP/JSON logs (ADR 0027,
 * 0234), so they land in Loki next to traces (Tempo) and metrics.
 *
 * - One batch per `service.name` (`granary`, `granary-ops`) every FLUSH_MS or
 *   MAX_BATCH records; the fan-out routes `granary-ops` only to sinks with
 *   `exportOps`, and masks registered secret values in every batch.
 * - Attributes become OTLP log attributes; `traceId`/`spanId` (hex, as OTLP/JSON
 *   requires) link a record to its Tempo trace.
 * - Records about the telemetry pipeline itself are not exported, so a failing
 *   sink cannot feed its own error loop; the sink's drop-oldest buffer bounds
 *   everything else.
 */
import { drainEarlyLogs, onLog, type LogLine } from './log';
import type { TelemetrySink } from '$lib/ops/contract';

const FLUSH_MS = 1000;
const MAX_BATCH = 200;
const SELF = /^ops telemetry|telemetry sink|otlp|^ops\/telemetry/i;
/** OTLP SeverityNumber: DEBUG=5, INFO=9, WARN=13, ERROR=17. */
const SEVERITY = { debug: [5, 'DEBUG'], info: [9, 'INFO'], warn: [13, 'WARN'], error: [17, 'ERROR'] } as const;

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
const str = (v: string) => ({ stringValue: v });
const any = (v: string | number | boolean): AnyValue =>
	typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
const HEX_TRACE = /^[0-9a-f]{32}$/;
const HEX_SPAN = /^[0-9a-f]{16}$/;

/** One ExportLogsServiceRequest (OTLP/JSON) for records of one service. */
export function encodeLogLines(lines: LogLine[], service: string): Uint8Array {
	const doc = {
		resourceLogs: [
			{
				resource: { attributes: [{ key: 'service.name', value: str(service) }] },
				scopeLogs: [
					{
						scope: { name: `${service}.log` },
						logRecords: lines.map((l) => ({
							timeUnixNano: String(BigInt(l.at) * 1_000_000n),
							observedTimeUnixNano: String(BigInt(l.at) * 1_000_000n),
							severityNumber: SEVERITY[l.level][0],
							severityText: SEVERITY[l.level][1],
							body: str(l.details.length ? `${l.message} ${l.details.join(' ')}` : l.message),
							attributes: [
								{ key: 'log.level', value: str(l.level) },
								...Object.entries(l.attrs).map(([key, v]) => ({ key, value: any(v) }))
							],
							...(l.traceId && HEX_TRACE.test(l.traceId) ? { traceId: l.traceId } : {}),
							...(l.spanId && HEX_SPAN.test(l.spanId) ? { spanId: l.spanId } : {})
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
	let pending: LogLine[] = drainEarlyLogs().filter((l) => !SELF.test(l.message));
	const flush = () => {
		if (pending.length === 0) return;
		const lines = pending;
		pending = [];
		if (sink.active && !sink.active()) return;
		const byService = new Map<string, LogLine[]>();
		for (const l of lines) (byService.get(l.service) ?? byService.set(l.service, []).get(l.service)!).push(l);
		for (const [service, recs] of byService)
			sink.write({ signal: 'logs', contentType: 'application/json', bytes: encodeLogLines(recs, service), service, producedAt: Date.now() });
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
