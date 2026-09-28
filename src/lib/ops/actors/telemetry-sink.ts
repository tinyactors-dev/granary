/**
 * `telemetry-sink/<sinkId>` — one per enabled sink (ADR 0082, 0085, 0121).
 *
 *   idle ──telemetry.batch──▶ waiting (entry: flush timer)
 *   waiting ──sink.flush | buffer ≥ FLUSH_AT_BYTES──▶ sending
 *   sending (entry: <send type="otlp"> otlp.export with the queue)
 *     ──sink.sent──▶ idle | waiting (more queued)
 *     ──sink.failed──▶ backoff (retry after Retry-After or 2^n s, ≤ 60 s)
 *                    ▶ open    (after OPEN_AFTER_FAILURES consecutive failures)
 *   backoff ──sink.flush──▶ sending
 *   open (entry: probe timer 60 s) ──sink.probe──▶ half-open
 *   half-open (entry: send the queue, or an empty probe)
 *     ──sink.sent──▶ idle | waiting   ──sink.failed──▶ open
 *
 * In every state `telemetry.batch` appends to a bounded byte buffer; on
 * overflow the oldest batches are dropped and counted (telemetry is lossy
 * by design, never persisted). `sink.probe` from the remediator
 * (`reset-sink-circuit`) closes an open circuit early. Spans of this family
 * are never exported (loop breaking, ADR 0093).
 */
import { statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, SEND_ID } from '../schemas/events';
import { OTLP_EXPORT_EVENT, OTLP_IO_TYPE, type OtlpExportRequest, type QueuedBatch } from '../io/otlp';

export const SINK_REVISION = 'v1';
export const FLUSH_AT_BYTES = 512 * 1024;
export const OPEN_AFTER_FAILURES = 5;
export const PROBE_AFTER_MS = 60_000;
export const MAX_BACKOFF_MS = 60_000;

export const SINK_STATES = {
	idle: 'idle',
	waiting: 'waiting',
	sending: 'sending',
	backoff: 'backoff',
	open: 'open',
	halfOpen: 'half-open'
} as const;

export interface SinkCounters {
	batches: number;
	bytes: number;
}

export interface TelemetrySinkData {
	sinkId: string;
	flushIntervalMs: number;
	maxBufferBytes: number;
	queue: QueuedBatch[];
	queuedBytes: number;
	inflight: QueuedBatch[];
	failures: number;
	retryAfterMs: number | null;
	sent: SinkCounters;
	dropped: SinkCounters;
	/** Dropped batches with timestamps for "dropped in the last 24 h". */
	dropLog: { at: number; bytes: number }[];
	lastError: string | null;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	openedAt: number | null;
}

export const initialSinkData = (sinkId: string, flushIntervalMs: number, maxBufferBytes: number): TelemetrySinkData => ({
	sinkId,
	flushIntervalMs,
	maxBufferBytes,
	queue: [],
	queuedBytes: 0,
	inflight: [],
	failures: 0,
	retryAfterMs: null,
	sent: { batches: 0, bytes: 0 },
	dropped: { batches: 0, bytes: 0 },
	dropLog: [],
	lastError: null,
	lastSuccessAt: null,
	lastFailureAt: null,
	openedAt: null
});

type Ctx = EvaluationContext<TelemetrySinkData>;
const DAY = 86_400_000;

function drop(d: TelemetrySinkData, b: QueuedBatch, now: number) {
	d.dropped.batches++;
	d.dropped.bytes += b.bytes.length;
	d.dropLog.push({ at: now, bytes: b.bytes.length });
	while (d.dropLog.length && d.dropLog[0]!.at < now - DAY) d.dropLog.shift();
	if (d.dropLog.length > 10_000) d.dropLog.splice(0, d.dropLog.length - 10_000);
}

/** Append to the bounded buffer, dropping the oldest batches on overflow. */
function enqueue(d: TelemetrySinkData, batches: QueuedBatch[], front = false) {
	const now = Date.now();
	if (front) d.queue.unshift(...batches);
	else d.queue.push(...batches);
	d.queuedBytes = d.queue.reduce((n, b) => n + b.bytes.length, 0);
	while (d.queuedBytes > d.maxBufferBytes && d.queue.length) {
		const old = d.queue.shift()!;
		d.queuedBytes -= old.bytes.length;
		drop(d, old, now);
	}
}

const pushBatch = ({ data, event }: Ctx) => enqueue(data, [event!.data as QueuedBatch]);
const full = ({ data }: Ctx) => data.queuedBytes >= FLUSH_AT_BYTES;
const hasQueue = ({ data }: Ctx) => data.queue.length > 0;

function takeQueue({ data }: Ctx): OtlpExportRequest {
	data.inflight = data.queue;
	data.queue = [];
	data.queuedBytes = 0;
	return { sinkId: data.sinkId, batches: data.inflight };
}

function onSent({ data, event }: Ctx) {
	const d = event!.data as { batches: number; bytes: number };
	data.sent.batches += d.batches;
	data.sent.bytes += d.bytes;
	data.inflight = [];
	data.failures = 0;
	data.retryAfterMs = null;
	data.lastSuccessAt = Date.now();
	data.openedAt = null;
}

function onFailed({ data, event }: Ctx) {
	const d = event!.data as { status: number | null; retryAfterMs: number | null; message: string };
	enqueue(data, data.inflight, true);
	data.inflight = [];
	data.failures++;
	data.retryAfterMs = d.retryAfterMs;
	data.lastError = d.message;
	data.lastFailureAt = Date.now();
}

const backoffDelay = ({ data }: Ctx) =>
	Math.min(MAX_BACKOFF_MS, data.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(6, data.failures)));

export function telemetrySinkChart(): DefinitionBuilder<TelemetrySinkData> {
	const S = SINK_STATES;
	return statechart<TelemetrySinkData>({ family: OPS_FAMILY.sink, revision: SINK_REVISION, name: 'telemetry-sink' })
		.data('sinkId', 'unset')
		.data('flushIntervalMs', 2000)
		.data('maxBufferBytes', 8 * 1024 * 1024)
		.data('queue', [])
		.data('queuedBytes', 0)
		.data('inflight', [])
		.data('failures', 0)
		.data('retryAfterMs', null)
		.data('sent', { batches: 0, bytes: 0 })
		.data('dropped', { batches: 0, bytes: 0 })
		.data('dropLog', [])
		.data('lastError', null)
		.data('lastSuccessAt', null)
		.data('lastFailureAt', null)
		.data('openedAt', null)
		.initial(S.idle)
		.state(S.idle, (s) =>
			s
				.on('telemetry.batch', (t) => t.when(full).target(S.sending).script(pushBatch))
				.on('telemetry.batch', (t) => t.target(S.waiting).script(pushBatch))
				.on('sink.flush')
				.on('sink.probe')
		)
		.state(S.waiting, (s) =>
			s
				.entry((a) => a.send('sink.flush', (b) => b.id(SEND_ID.flush).after(({ data }: Ctx) => data.flushIntervalMs)))
				.exit((a) => a.cancel(SEND_ID.flush))
				.on('telemetry.batch', (t) => t.when(full).target(S.sending).script(pushBatch))
				.on('telemetry.batch', (t) => t.internal().script(pushBatch))
				.on('sink.flush', (t) => t.target(S.sending))
				.on('sink.probe')
		)
		.state(S.sending, (s) =>
			s
				.entry((a) => a.send(OTLP_EXPORT_EVENT, (b) => b.via(OTLP_IO_TYPE).data(takeQueue)))
				.on('telemetry.batch', (t) => t.internal().script(pushBatch))
				.on('sink.sent', (t) => t.when(hasQueue).target(S.waiting).script(onSent))
				.on('sink.sent', (t) => t.target(S.idle).script(onSent))
				.on('sink.failed', (t) => t.when(({ data }: Ctx) => data.failures + 1 >= OPEN_AFTER_FAILURES).target(S.open).script(onFailed))
				.on('sink.failed', (t) => t.target(S.backoff).script(onFailed))
				.on('error.communication', (t) => t.target(S.backoff).script((ctx: Ctx) => {
					enqueue(ctx.data, ctx.data.inflight, true);
					ctx.data.inflight = [];
					ctx.data.failures++;
					ctx.data.lastError = 'otlp processor failed';
				}))
				.on('sink.probe')
		)
		.state(S.backoff, (s) =>
			s
				.entry((a) => a.send('sink.flush', (b) => b.id(SEND_ID.retry).after(backoffDelay)))
				.exit((a) => a.cancel(SEND_ID.retry))
				.on('telemetry.batch', (t) => t.internal().script(pushBatch))
				.on('sink.flush', (t) => t.target(S.sending))
				.on('sink.probe', (t) => t.target(S.sending))
		)
		.state(S.open, (s) =>
			s
				.entry((a) =>
					a
						.script(({ data }: Ctx) => {
							data.openedAt ??= Date.now();
						})
						.send('sink.probe', (b) => b.id(SEND_ID.probe).after(PROBE_AFTER_MS))
				)
				.exit((a) => a.cancel(SEND_ID.probe))
				.on('telemetry.batch', (t) => t.internal().script(pushBatch))
				.on('sink.probe', (t) => t.target(S.halfOpen))
				.on('sink.flush')
		)
		.state(S.halfOpen, (s) =>
			s
				.entry((a) => a.send(OTLP_EXPORT_EVENT, (b) => b.via(OTLP_IO_TYPE).data(takeQueue)))
				.on('telemetry.batch', (t) => t.internal().script(pushBatch))
				.on('sink.sent', (t) => t.when(hasQueue).target(S.waiting).script(onSent))
				.on('sink.sent', (t) => t.target(S.idle).script(onSent))
				.on('sink.failed', (t) => t.target(S.open).script(onFailed))
				.on('error.communication', (t) => t.target(S.open).script((ctx: Ctx) => {
					enqueue(ctx.data, ctx.data.inflight, true);
					ctx.data.inflight = [];
					ctx.data.failures++;
				}))
				.on('sink.probe')
				.on('sink.flush')
		);
}

/** Dropped bytes/batches in the last 24 h (for status and stats). */
export function droppedLast24h(d: TelemetrySinkData, now = Date.now()): { batches: number; bytes: number } {
	let batches = 0;
	let bytes = 0;
	for (const e of d.dropLog) if (e.at >= now - DAY) {
		batches++;
		bytes += e.bytes;
	}
	return { batches, bytes };
}
