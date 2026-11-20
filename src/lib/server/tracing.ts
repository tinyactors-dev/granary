/**
 * Trace export (ADR 0007, ADR 0042, ADR 0300).
 *
 * The host's telemetry encoder (`hostConfig`: service `granary`, detail
 * `decisions`, values) hands each OTLP request to `onExport`. Traces are
 * decoded, every span of a named actor gets `granary.actor.family`,
 * `granary.actor.name` and `granary.actor.address` from the native
 * `tinyactors.actor.name`, and `scxml.finished` spans of issue actors get
 * `granary.done.*` from the done-data (`noteDone`, called by `onDone`).
 * Spans of known actors are renamed `<family> <kind> …` (ADR 0155). The batch
 * is then re-encoded and handed to the ops module's telemetry sink
 * (`attachSink`, ADR 0121), which fans it out to the configured OTLP sinks
 * (seeded with `GRANARY_SEED_OTLP_*`, ADR 0230); log requests pass through.
 * Without an ops sink (ops failed to start) nothing is exported. The last
 * SPAN_BUFFER_SIZE spans are kept in memory for /admin/traces
 * (`getRecentSpans`, `listRecentTraces`, ADR 0054, 0290).
 */
import { decodeTraces, type Actor, type Host, type HostConfig } from '@tinyactors/node';
import { applyFamilySpanName, spanKindOf } from '../trace/span-name';
import type { GetRecentSpansInput, ListRecentTracesInput, SpanAttributeValue, SpanSummary, TraceSummary } from '../schemas/dev';
import { summarizeTraces } from './trace-summary';
import { SPAN_BUFFER_SIZE } from '../schemas/dev';
import type { Resolved } from '../schemas/api';
import type { IssueDoneData } from '../schemas/actors';
import { parseAddress } from '../schemas/actors';
import { encodeTraces, fromTinyactors, type DecodedSpan } from './otlp-encode';
import { log } from './log';
import type { TelemetrySink } from '../ops/contract';

/** Attribute keys granary adds to tinyactors spans (ADR 0042). */
export const GRANARY_ATTRS = {
	family: 'granary.actor.family',
	name: 'granary.actor.name',
	address: 'granary.actor.address',
	doneVerdict: 'granary.done.verdict',
	doneReason: 'granary.done.reason',
	doneDeliveryId: 'granary.done.delivery_id'
} as const;

export const SERVICE_NAME = 'granary';
/** A traces request at most this long after its first span (the host's clock runs in ms). */
export const FLUSH_INTERVAL_MS = 100;

export interface TracerOptions {
	/** Keep the last SPAN_BUFFER_SIZE decoded spans (for /admin). */
	keepRecent: boolean;
}

export class Tracer {
	readonly #keepRecent: boolean;
	/** session id (decimal) → done-data, consumed when its `scxml.finished` span passes. */
	#done = new Map<string, IssueDoneData>();
	#recent: SpanSummary[] = [];
	#closed = false;
	/** The ops module's fan-out; when set, granary never POSTs itself. */
	#sink: TelemetrySink | null = null;

	constructor(opts: TracerOptions) {
		this.#keepRecent = opts.keepRecent;
	}

	/** The host config's telemetry part (`new Host(charts, { config })`). */
	hostConfig(): HostConfig {
		return {
			system: { ticksPerSecond: 1000 },
			telemetry: { flushInterval: FLUSH_INTERVAL_MS, values: true, resource: { 'service.name': SERVICE_NAME } }
		};
	}

	/** Sets the host's trace detail (ADR 0042: decisions, with values). */
	attachHost(host: Host): void {
		host.traceConfigure({ detail: 'decisions', values: true }).catch((e) => log.error('tracing: traceConfigure failed', e));
	}

	close(): void {
		this.#flushOwn();
		this.#closed = true;
		this.#sink = null;
	}

	/** Route exports through the ops module (ADR 0121). */
	attachSink(sink: TelemetrySink): void {
		this.#sink = sink;
	}

	/** The issue actor's done-data (from `onDone`): attached to its session's `scxml.finished` span. */
	noteDone(actor: Actor, done: IssueDoneData): void {
		this.#done.set(String(actor.id), done);
		if (this.#done.size > 10_000) this.#done.delete(this.#done.keys().next().value!);
	}

	/** The host's `telemetry` handler. */
	onExport(signal: 'traces' | 'logs', data: Uint8Array): void {
		if (this.#closed) return;
		const sink = this.#sink;
		const exporting = sink ? (sink.active?.() ?? true) : false;
		if (signal === 'logs') {
			if (exporting && data.length) this.#export('logs', data.slice()); // the sink may hold it for a while
			return;
		}
		if (!exporting && !this.#keepRecent) return;
		let spans: DecodedSpan[];
		try {
			spans = decodeTraces(data).map(fromTinyactors);
			this.#enrich(spans);
		} catch (e) {
			log.error('tracing: could not decode/enrich a batch', e);
			if (exporting) this.#export('traces', data.slice());
			return;
		}
		if (exporting) this.#export('traces', encodeTraces(spans));
		if (this.#keepRecent) this.#remember(spans);
	}

	#own: DecodedSpan[] = [];
	#ownTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Spans granary produces itself (HTTP server spans, ADR 0234), exported in
	 * small batches alongside the actors' spans and kept in the dev ring buffer.
	 */
	emitSpan(span: DecodedSpan): void {
		if (this.#closed) return;
		const exporting = this.#sink ? (this.#sink.active?.() ?? true) : false;
		if (!exporting && !this.#keepRecent) return;
		this.#own.push(span);
		if (this.#own.length >= 200) this.#flushOwn();
		else if (!this.#ownTimer) {
			this.#ownTimer = setTimeout(() => this.#flushOwn(), 1000);
			(this.#ownTimer as { unref?: () => void }).unref?.();
		}
	}

	#flushOwn(): void {
		if (this.#ownTimer) clearTimeout(this.#ownTimer);
		this.#ownTimer = null;
		const spans = this.#own;
		this.#own = [];
		if (!spans.length) return;
		if (this.#sink && (this.#sink.active?.() ?? true)) this.#export('traces', encodeTraces(spans));
		if (this.#keepRecent) this.#remember(spans);
	}

	#export(signal: 'traces' | 'logs', bytes: Uint8Array): void {
		this.#sink?.write({ signal, contentType: 'application/x-protobuf', bytes, service: SERVICE_NAME, producedAt: Date.now() });
	}

	#enrich(spans: DecodedSpan[]): void {
		for (const s of spans) {
			const actorName = s.attributes['tinyactors.actor.name'];
			let family: string | undefined;
			if (typeof actorName === 'string' && actorName.includes('/')) {
				const address = parseAddress(actorName);
				family = address.family;
				s.attributes[GRANARY_ATTRS.family] = address.family;
				s.attributes[GRANARY_ATTRS.name] = address.name;
				s.attributes[GRANARY_ATTRS.address] = actorName;
			}
			const kind = spanKindOf(s);
			// `scxml.macrostep issue.opened` → `issue macrostep issue.opened` (ADR 0155)
			applyFamilySpanName(s, family);
			if (kind === 'finished') {
				const key = String(s.attributes['scxml.session_id']);
				const done = this.#done.get(key);
				if (done) {
					s.attributes[GRANARY_ATTRS.doneVerdict] = done.verdict;
					s.attributes[GRANARY_ATTRS.doneReason] = done.reason;
					if (done.deliveryId) s.attributes[GRANARY_ATTRS.doneDeliveryId] = done.deliveryId;
					this.#done.delete(key);
				}
			}
		}
	}

	#remember(spans: DecodedSpan[]): void {
		for (const s of spans) this.#recent.push(toSummary(s));
		if (this.#recent.length > SPAN_BUFFER_SIZE) this.#recent.splice(0, this.#recent.length - SPAN_BUFFER_SIZE);
	}

	/** Newest first. */
	recent(q: Resolved<GetRecentSpansInput>): SpanSummary[] {
		const out: SpanSummary[] = [];
		for (let i = this.#recent.length - 1; i >= 0 && out.length < q.limit; i--) {
			const s = this.#recent[i]!;
			if (q.family && s.attributes[GRANARY_ATTRS.family] !== q.family) continue;
			if (q.traceId && s.traceId !== q.traceId) continue;
			out.push(s);
		}
		return out;
	}

	/** The buffer grouped by trace, newest first (ADR 0054). */
	traces(q: Resolved<ListRecentTracesInput>): TraceSummary[] {
		return summarizeTraces(this.#recent, q);
	}
}

function attrValue(v: unknown): SpanAttributeValue {
	if (v === null || v === undefined) return null;
	if (typeof v === 'string' || typeof v === 'boolean') return v;
	if (typeof v === 'number') return v;
	if (typeof v === 'bigint') return v.toString();
	return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

function attrs(a: Record<string, unknown>): Record<string, SpanAttributeValue> {
	const out: Record<string, SpanAttributeValue> = {};
	for (const [k, v] of Object.entries(a)) out[k] = attrValue(v);
	return out;
}

function toSummary(s: DecodedSpan): SpanSummary {
	return {
		traceId: s.traceID,
		spanId: s.spanID,
		parentSpanId: s.parentSpanID ?? null,
		name: s.name,
		kind: s.kind,
		start: s.startTime,
		end: s.endTime,
		durationMs: Math.max(0, s.endTime - s.startTime),
		attributes: attrs(s.attributes),
		status: { code: s.status.code, message: s.status.message ?? null },
		events: s.events.map((e) => ({ name: e.name, time: e.time, attributes: attrs(e.attributes) })),
		service: typeof s.resource?.attributes?.['service.name'] === 'string' ? (s.resource.attributes['service.name'] as string) : null,
		links: s.links.map((l) => ({ traceId: l.traceID, spanId: l.spanID, attributes: attrs(l.attributes) })),
		// The causing step is the parent span (the host traces with `linkParents` off).
		cause: null
	};
}
