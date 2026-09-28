/**
 * Trace export (ADR 0007, ADR 0042).
 *
 * `setTraceSink` with `resource: {'service.name': 'granary'}`,
 * `detail: 'decisions'`, `values: true`. Each pump turn's batch is decoded,
 * every span of a known actor session gets `granary.actor.family`,
 * `granary.actor.name` and `granary.actor.address`, and `scxml.finished`
 * spans of issue actors get `granary.done.*` from the done-data. Spans of
 * known actors are renamed `<family> <kind> …` (ADR 0155), keeping the original
 * name in `tinyactors.span.name` and the kind in `tinyactors.span.kind`. The batch
 * is then re-encoded and handed to the ops module's telemetry sink
 * (`attachSink`, ADR 0121), which fans it out to the configured OTLP sinks
 * (seeded with `GRANARY_SEED_OTLP_*`, ADR 0230). Without an ops sink (ops
 * failed to start) nothing is exported. In dev mode the last SPAN_BUFFER_SIZE spans are kept
 * in memory for `/__dev` (`getRecentSpans`, `listRecentTraces`, ADR 0054).
 */
import { applyFamilySpanName, spanKindOf } from '../trace/span-name';
import { decodeTraces, stepSpanID, type ActorInspection, type DecodedSpan, type System } from '@tinyactors/node';
import type { GetRecentSpansInput, ListRecentTracesInput, SpanAttributeValue, SpanSummary, TraceSummary } from '../schemas/dev';
import { summarizeTraces } from './trace-summary';
import { SPAN_BUFFER_SIZE } from '../schemas/dev';
import type { Resolved } from '../schemas/api';
import type { ActorAddress, IssueDoneData } from '../schemas/actors';
import { FAMILY, ALLOWLIST_ADDRESS, formatAddress } from '../schemas/actors';
import { encodeTraces } from './otlp-encode';
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

/** Name of an actor from its inspection: issue actors by `data.issueKey`, the allowlist is `main`. */
export function addressOfInspection(i: ActorInspection): ActorAddress | null {
	const family = i.definition.family;
	if (family === FAMILY.allowlist) return ALLOWLIST_ADDRESS;
	const data = i.data as { issueKey?: unknown } | undefined;
	if (family === FAMILY.issue && typeof data?.issueKey === 'string') return { family, name: data.issueKey };
	return null;
}

export interface TracerOptions {
	system: System;
	/** Keep the last 200 decoded spans (dev mode). */
	keepRecent: boolean;
}

export class Tracer {
	readonly #system: System;
	readonly #keepRecent: boolean;
	/** session id (decimal) → address; entries of destroyed actors are pruned lazily. */
	#sessions = new Map<string, ActorAddress>();
	/** session id → done-data, consumed when its `scxml.finished` span passes. */
	#done = new Map<string, IssueDoneData>();
	#recent: SpanSummary[] = [];
	#closed = false;
	#installed = false;
	/** The ops module's fan-out; when set, granary never POSTs itself. */
	#sink: TelemetrySink | null = null;

	constructor(opts: TracerOptions) {
		this.#system = opts.system;
		this.#keepRecent = opts.keepRecent;
	}

	/** Installs the sink when there is somewhere for spans to go. */
	install(): boolean {
		if (this.#installed) return true;
		if (!this.#keepRecent && !this.#sink) return false;
		this.#installed = true;
		this.#system.setTraceSink((traces, logs) => this.#onBatch(traces, logs), {
			resource: { 'service.name': SERVICE_NAME },
			detail: 'decisions',
			values: true
		});
		return true;
	}

	close(): void {
		this.#closed = true;
		this.#sink = null;
	}

	/** Route exports through the ops module (ADR 0121). */
	attachSink(sink: TelemetrySink): void {
		this.#sink = sink;
		this.install();
	}

	/** Remember who a session is (spawn, done hook, fault hook). */
	noteActor(inspection: ActorInspection): void {
		const address = addressOfInspection(inspection);
		if (address) this.#sessions.set(String(inspection.sessionID), address);
	}

	/** The done hook's record: attached to the session's `scxml.finished` span. */
	noteDone(inspection: ActorInspection, done: IssueDoneData): void {
		this.noteActor(inspection);
		this.#done.set(String(inspection.sessionID), done);
	}

	#lookup(session: string, batch: { scanned: boolean }): ActorAddress | undefined {
		const a = this.#sessions.get(session);
		if (a || batch.scanned) return a;
		// Unknown session: learn every resident actor, once per batch.
		batch.scanned = true;
		for (const i of this.#system.actors()) this.noteActor(i);
		return this.#sessions.get(session);
	}

	#onBatch(traces: Uint8Array, logs?: Uint8Array): void {
		if (this.#closed) return;
		const sink = this.#sink;
		const exporting = sink ? (sink.active?.() ?? true) : false;
		if (!exporting && !this.#keepRecent) {
			// Nobody wants spans right now; keep the lookup maps bounded.
			if (this.#sessions.size > 10_000) this.#sessions.clear();
			if (this.#done.size > 10_000) this.#done.clear();
			return;
		}
		let spans: DecodedSpan[];
		try {
			spans = decodeTraces(traces);
			this.#enrich(spans);
		} catch (e) {
			log.error('tracing: could not decode/enrich a batch', e);
			if (exporting) this.#export('traces', traces.slice());
			return;
		}
		if (exporting) {
			this.#export('traces', encodeTraces(spans));
			if (logs && logs.length) this.#export('logs', logs.slice()); // the sink may hold it for a while
		}
		if (this.#keepRecent) this.#remember(spans);
	}

	#export(signal: 'traces' | 'logs', bytes: Uint8Array): void {
		this.#sink?.write({ signal, contentType: 'application/x-protobuf', bytes, service: SERVICE_NAME, producedAt: Date.now() });
	}

	#enrich(spans: DecodedSpan[]): void {
		const destroyed: string[] = [];
		const batch = { scanned: false };
		for (const s of spans) {
			const session = s.attributes['scxml.session_id'];
			if (session === undefined) continue;
			const key = String(session);
			const address = this.#lookup(key, batch);
			if (address) {
				s.attributes[GRANARY_ATTRS.family] = address.family;
				s.attributes[GRANARY_ATTRS.name] = address.name;
				s.attributes[GRANARY_ATTRS.address] = formatAddress(address);
			}
			const kind = spanKindOf(s);
			// `scxml.macrostep issue.opened` → `issue macrostep issue.opened` (ADR 0155)
			applyFamilySpanName(s, address?.family);
			if (kind === 'finished') {
				const done = this.#done.get(key);
				if (done) {
					s.attributes[GRANARY_ATTRS.doneVerdict] = done.verdict;
					s.attributes[GRANARY_ATTRS.doneReason] = done.reason;
					if (done.deliveryId) s.attributes[GRANARY_ATTRS.doneDeliveryId] = done.deliveryId;
					this.#done.delete(key);
				}
			}
			if (kind === 'destroyed') destroyed.push(key);
		}
		for (const key of destroyed) {
			this.#sessions.delete(key);
			this.#done.delete(key);
		}
	}

	#remember(spans: DecodedSpan[]): void {
		for (const s of spans) this.#recent.push(toSummary(s));
		if (this.#recent.length > SPAN_BUFFER_SIZE) this.#recent.splice(0, this.#recent.length - SPAN_BUFFER_SIZE);
	}

	/** Fill `cause.traceId` for causes that are (now) in the buffer. */
	#resolveCauses(): void {
		let byId: Map<string, string> | null = null;
		for (const s of this.#recent) {
			if (!s.cause || s.cause.traceId) continue;
			byId ??= new Map(this.#recent.map((x) => [x.spanId, x.traceId]));
			s.cause.traceId = byId.get(s.cause.spanId) ?? null;
		}
	}

	/** Newest first. */
	recent(q: Resolved<GetRecentSpansInput>): SpanSummary[] {
		this.#resolveCauses();
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
		this.#resolveCauses();
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
		cause: causeOf(s)
	};
}

/** The causing step's span id from `scxml.cause.*` (ADR 0054). */
function causeOf(s: DecodedSpan): SpanSummary['cause'] {
	const session = s.attributes['scxml.cause.session_id'];
	const macrostep = s.attributes['scxml.cause.macrostep'];
	if (session === undefined || macrostep === undefined) return null;
	const microstep = s.attributes['scxml.cause.microstep'];
	try {
		const spanId = stepSpanID(session as bigint | number, macrostep as bigint | number, Number(microstep ?? 0));
		return spanId === s.spanID ? null : { spanId, traceId: null };
	} catch {
		return null;
	}
}
