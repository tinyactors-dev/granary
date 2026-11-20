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
 * (`reset-sink-circuit`) closes an open circuit early. The ops host's trace
 * rule drops every step of this chart (loop breaking, ADR 0093).
 *
 * All of the sink's state is the one variable `d` (`TelemetrySinkData`),
 * changed in place by the chart's helpers.
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, SEND_ID } from '../schemas/events';
import { OTLP_EXPORT_EVENT, OTLP_IO_TYPE, type QueuedBatch } from '../io/otlp';

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
	/** Test hook (GRANARY_TEST_GRACE_SCALE, ADR 0150): scales backoff and probe delays; 1 in production. */
	timeScale: number;
}

export const initialSinkData = (sinkId: string, flushIntervalMs: number, maxBufferBytes: number, timeScale = 1): TelemetrySinkData => ({
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
	openedAt: null,
	timeScale
});

const DAY = 86_400_000;

/** The chart's helpers: self-contained (constants inlined, named in comments). */
const helpers = {
	/** Append to the bounded buffer, dropping (and counting) the oldest batches on overflow. */
	enqueue: (d: TelemetrySinkData, batches: QueuedBatch[], front: boolean) => {
		const now = Date.now();
		if (front) d.queue.unshift(...batches);
		else d.queue.push(...batches);
		d.queuedBytes = d.queue.reduce((n, b) => n + b.bytes.length, 0);
		while (d.queuedBytes > d.maxBufferBytes && d.queue.length) {
			const old = d.queue.shift()!;
			d.queuedBytes -= old.bytes.length;
			d.dropped.batches++;
			d.dropped.bytes += old.bytes.length;
			d.dropLog.push({ at: now, bytes: old.bytes.length });
			while (d.dropLog.length && d.dropLog[0]!.at < now - 86_400_000) d.dropLog.shift(); // DAY
			if (d.dropLog.length > 10_000) d.dropLog.splice(0, d.dropLog.length - 10_000);
		}
	},
	/** FLUSH_AT_BYTES = 512 KiB. */
	full: (d: TelemetrySinkData) => d.queuedBytes >= 512 * 1024,
	/** The export request: the queue moves in flight. */
	takeQueue: (d: TelemetrySinkData) => {
		d.inflight = d.queue;
		d.queue = [];
		d.queuedBytes = 0;
		return { sinkId: d.sinkId, batches: d.inflight };
	},
	onSent: (d: TelemetrySinkData, e: { batches: number; bytes: number }) => {
		d.sent.batches += e.batches;
		d.sent.bytes += e.bytes;
		d.inflight = [];
		d.failures = 0;
		d.retryAfterMs = null;
		d.lastSuccessAt = Date.now();
		d.openedAt = null;
	},
	/** The batches in flight go back to the front of the queue (`enqueue(d, inflight, true)`). */
	onFailed: (d: TelemetrySinkData, e: { retryAfterMs: number | null; message: string } | null) => {
		const now = Date.now();
		const back = d.inflight;
		d.inflight = [];
		d.queue.unshift(...back);
		d.queuedBytes = d.queue.reduce((n, b) => n + b.bytes.length, 0);
		while (d.queuedBytes > d.maxBufferBytes && d.queue.length) {
			const old = d.queue.shift()!;
			d.queuedBytes -= old.bytes.length;
			d.dropped.batches++;
			d.dropped.bytes += old.bytes.length;
			d.dropLog.push({ at: now, bytes: old.bytes.length });
		}
		d.failures++;
		if (e) {
			d.retryAfterMs = e.retryAfterMs;
			d.lastError = e.message;
			d.lastFailureAt = now;
		} else d.lastError = 'otlp processor failed';
	},
	/** MAX_BACKOFF_MS = 60 s; tests (timeScale < 1) never go below 200 ms so a down sink doesn't spin. */
	backoffDelay: (d: TelemetrySinkData) => {
		const ms = Math.min(60_000, d.retryAfterMs ?? Math.min(60_000, 1000 * 2 ** Math.min(6, d.failures)));
		return d.timeScale >= 1 ? ms : Math.max(200, Math.round(ms * d.timeScale));
	},
	/** PROBE_AFTER_MS = 60 s, scaled as `backoffDelay`. */
	probeDelay: (d: TelemetrySinkData) => (d.timeScale >= 1 ? 60_000 : Math.max(200, Math.round(60_000 * d.timeScale)))
};

const S = SINK_STATES;
const push = scxml`<script>enqueue(d, [_event.data], false)</script>`;
const exportQueue = scxml`<send type="${OTLP_IO_TYPE}" event="${OTLP_EXPORT_EVENT}"><content expr="takeQueue(d)"/></send>`;
const batchIn = (whenFull: boolean) =>
	whenFull
		? scxml`<transition event="telemetry.batch" type="internal">${push}<if cond="full(d)"><raise event="sink.full"/></if></transition>`
		: scxml`<transition event="telemetry.batch" type="internal">${push}</transition>`;
const sent = scxml`
	<transition event="sink.sent" cond="d.queue.length > 0" target="${S.waiting}"><script>onSent(d, _event.data)</script></transition>
	<transition event="sink.sent" target="${S.idle}"><script>onSent(d, _event.data)</script></transition>`;

export const telemetrySinkChart = chart({
	name: OPS_FAMILY.sink,
	initial: S.idle,
	helpers,
	data: { d: initialSinkData('unset', 2000, 8 * 1024 * 1024) },
	body: scxml`
<state id="${S.idle}">
	<transition event="telemetry.batch" target="${S.waiting}">${push}<if cond="full(d)"><raise event="sink.full"/></if></transition>
</state>
<state id="${S.waiting}">
	<onentry><send event="sink.flush" id="${SEND_ID.flush}" delayexpr="d.flushIntervalMs + 'ms'"/></onentry>
	<onexit><cancel sendid="${SEND_ID.flush}"/></onexit>
	${batchIn(true)}
	<transition event="sink.flush" target="${S.sending}"/>
	<transition event="sink.full" target="${S.sending}"/>
</state>
<state id="${S.sending}">
	<onentry>${exportQueue}</onentry>
	${batchIn(false)}
	${sent}
	<transition event="sink.failed" cond="${`d.failures + 1 >= ${OPEN_AFTER_FAILURES}`}" target="${S.open}"><script>onFailed(d, _event.data)</script></transition>
	<transition event="sink.failed" target="${S.backoff}"><script>onFailed(d, _event.data)</script></transition>
	<transition event="error.communication" target="${S.backoff}"><script>onFailed(d, null)</script></transition>
</state>
<state id="${S.backoff}">
	<onentry><send event="sink.flush" id="${SEND_ID.retry}" delayexpr="backoffDelay(d) + 'ms'"/></onentry>
	<onexit><cancel sendid="${SEND_ID.retry}"/></onexit>
	${batchIn(false)}
	<transition event="sink.flush" target="${S.sending}"/>
	<transition event="sink.probe" target="${S.sending}"/>
</state>
<state id="${S.open}">
	<onentry>
		<script>if (d.openedAt === null) d.openedAt = Date.now();</script>
		<send event="sink.probe" id="${SEND_ID.probe}" delayexpr="probeDelay(d) + 'ms'"/>
	</onentry>
	<onexit><cancel sendid="${SEND_ID.probe}"/></onexit>
	${batchIn(false)}
	<transition event="sink.probe" target="${S.halfOpen}"/>
</state>
<state id="${S.halfOpen}">
	<onentry>${exportQueue}</onentry>
	${batchIn(false)}
	${sent}
	<transition event="sink.failed" target="${S.open}"><script>onFailed(d, _event.data)</script></transition>
	<transition event="error.communication" target="${S.open}"><script>onFailed(d, null)</script></transition>
</state>`
});

/** Dropped bytes/batches in the last 24 h (for status and stats). */
export function droppedLast24h(d: TelemetrySinkData, now = Date.now()): { batches: number; bytes: number } {
	let batches = 0;
	let bytes = 0;
	for (const e of d.dropLog)
		if (e.at >= now - DAY) {
			batches++;
			bytes += e.bytes;
		}
	return { batches, bytes };
}
