/**
 * Minimal OTLP/protobuf wire helpers for the telemetry fan-out (ADR 0093, 0121).
 *
 * The fan-out never re-encodes a batch from decoded objects. Instead it
 * works on the wire format:
 *   - `maskSensitiveAttributes` overwrites, *in place and with the same
 *     length*, the string values of attributes whose key looks like a secret
 *     (`authorization`, `token`, …). Same-length edits keep every protobuf
 *     length prefix valid.
 *   - `filterSpans` rebuilds an ExportTraceServiceRequest keeping only the
 *     spans a predicate accepts, by copying the raw bytes of kept messages
 *     (used for loop breaking and sampling).
 *
 * Message layouts follow opentelemetry-proto v1 (trace, logs, common).
 */

const LEN = 2;

interface Field {
	no: number;
	wire: number;
	/** Start of the value (after tag, and after the length prefix for LEN). */
	start: number;
	end: number;
	/** Start of the tag (for raw copies of the whole field). */
	tagStart: number;
	varint?: bigint;
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
	let result = 0n;
	let shift = 0n;
	for (;;) {
		if (pos >= buf.length) throw new Error('truncated varint');
		const b = buf[pos++]!;
		result |= BigInt(b & 0x7f) << shift;
		if (b < 0x80) return [result, pos];
		shift += 7n;
		if (shift > 70n) throw new Error('varint too long');
	}
}

/** Iterate the top-level fields of a message in `buf[start, end)`. */
function* fields(buf: Uint8Array, start = 0, end = buf.length): Generator<Field> {
	let pos = start;
	while (pos < end) {
		const tagStart = pos;
		const [tag, p1] = readVarint(buf, pos);
		pos = p1;
		const no = Number(tag >> 3n);
		const wire = Number(tag & 7n);
		switch (wire) {
			case 0: {
				const [v, p2] = readVarint(buf, pos);
				yield { no, wire, start: pos, end: p2, tagStart, varint: v };
				pos = p2;
				break;
			}
			case 1:
				yield { no, wire, start: pos, end: pos + 8, tagStart };
				pos += 8;
				break;
			case LEN: {
				const [len, p2] = readVarint(buf, pos);
				const s = p2;
				const e = s + Number(len);
				if (e > end) throw new Error('truncated length-delimited field');
				yield { no, wire, start: s, end: e, tagStart };
				pos = e;
				break;
			}
			case 5:
				yield { no, wire, start: pos, end: pos + 4, tagStart };
				pos += 4;
				break;
			default:
				throw new Error(`unsupported wire type ${wire}`);
		}
	}
	if (pos !== end) throw new Error('message overran its length');
}

const decoder = new TextDecoder();
const text = (buf: Uint8Array, f: Field) => decoder.decode(buf.subarray(f.start, f.end));

/** Attribute keys whose values are never exported (ADR 0093 rule 2). */
export const SENSITIVE_KEY = /authorization|token|secret|password|passwd|api[-_]?key|cookie|granary_session/i;

function maskRange(buf: Uint8Array, start: number, end: number): number {
	for (let i = start; i < end; i++) buf[i] = 0x2a; // '*'
	return end - start > 0 ? 1 : 0;
}

/** AnyValue { 1 string, 5 ArrayValue{1 AnyValue*}, 6 KeyValueList{1 KeyValue*} }. */
function maskAnyValue(buf: Uint8Array, start: number, end: number, all: boolean): number {
	let n = 0;
	for (const f of fields(buf, start, end)) {
		if (f.wire !== LEN) continue;
		if (f.no === 1) {
			if (all) n += maskRange(buf, f.start, f.end);
		} else if (f.no === 5) {
			for (const g of fields(buf, f.start, f.end)) {
				if (g.no === 1 && g.wire === LEN) n += maskAnyValue(buf, g.start, g.end, all);
			}
		} else if (f.no === 6) {
			for (const g of fields(buf, f.start, f.end)) {
				if (g.no === 1 && g.wire === LEN) n += maskKeyValue(buf, g.start, g.end);
			}
		}
	}
	return n;
}

/** KeyValue { 1 key, 2 AnyValue }. */
function maskKeyValue(buf: Uint8Array, start: number, end: number): number {
	let sensitive = false;
	let value: Field | null = null;
	for (const f of fields(buf, start, end)) {
		if (f.no === 1 && f.wire === LEN) sensitive = SENSITIVE_KEY.test(text(buf, f));
		else if (f.no === 2 && f.wire === LEN) value = f;
	}
	return value ? maskAnyValue(buf, value.start, value.end, sensitive) : 0;
}

function maskAttributesIn(buf: Uint8Array, start: number, end: number, attrField: number): number {
	let n = 0;
	for (const f of fields(buf, start, end)) if (f.no === attrField && f.wire === LEN) n += maskKeyValue(buf, f.start, f.end);
	return n;
}

/** Resource { 1 KeyValue* } and InstrumentationScope { 3 KeyValue* }. */
const maskResource = (buf: Uint8Array, f: Field) => maskAttributesIn(buf, f.start, f.end, 1);
const maskScope = (buf: Uint8Array, f: Field) => maskAttributesIn(buf, f.start, f.end, 3);

function maskSpan(buf: Uint8Array, start: number, end: number): number {
	let n = 0;
	for (const f of fields(buf, start, end)) {
		if (f.wire !== LEN) continue;
		if (f.no === 9) n += maskKeyValue(buf, f.start, f.end); // attributes
		else if (f.no === 11) n += maskAttributesIn(buf, f.start, f.end, 3); // Event.attributes
		else if (f.no === 13) n += maskAttributesIn(buf, f.start, f.end, 4); // Link.attributes
	}
	return n;
}

function maskLogRecord(buf: Uint8Array, start: number, end: number): number {
	let n = 0;
	for (const f of fields(buf, start, end)) {
		if (f.wire !== LEN) continue;
		if (f.no === 6) n += maskKeyValue(buf, f.start, f.end); // attributes
		else if (f.no === 5) n += maskAnyValue(buf, f.start, f.end, false); // body: nested kvlists only
	}
	return n;
}

/**
 * Mask the string values of sensitive attribute keys, in place. Returns the
 * number of values masked. Throws on malformed input (callers drop the batch).
 * Metrics batches are ops-generated and skipped.
 */
export function maskSensitiveAttributes(buf: Uint8Array, signal: 'traces' | 'logs' | 'metrics'): number {
	if (signal === 'metrics') return 0;
	let n = 0;
	for (const top of fields(buf)) {
		if (top.no !== 1 || top.wire !== LEN) continue; // Resource{Spans,Logs}
		for (const r of fields(buf, top.start, top.end)) {
			if (r.wire !== LEN) continue;
			if (r.no === 1) n += maskResource(buf, r);
			else if (r.no === 2) {
				for (const s of fields(buf, r.start, r.end)) {
					if (s.wire !== LEN) continue;
					if (s.no === 1) n += maskScope(buf, s);
					else if (s.no === 2) n += signal === 'traces' ? maskSpan(buf, s.start, s.end) : maskLogRecord(buf, s.start, s.end);
				}
			}
		}
	}
	return n;
}

/** What `filterSpans` tells the predicate about a span. */
export interface SpanFacts {
	traceId: Uint8Array;
	name: string;
	/** Status.code: 0 unset, 1 ok, 2 error. */
	statusCode: number;
	/** Integer/string attribute values by key (only keys asked for). */
	attr(key: string): bigint | string | undefined;
}

function spanFacts(buf: Uint8Array, start: number, end: number): SpanFacts {
	let traceId: Uint8Array = new Uint8Array(0);
	let name = '';
	let statusCode = 0;
	const attrFields: Field[] = [];
	for (const f of fields(buf, start, end)) {
		if (f.wire !== LEN) continue;
		if (f.no === 1) traceId = buf.subarray(f.start, f.end);
		else if (f.no === 5) name = text(buf, f);
		else if (f.no === 9) attrFields.push(f);
		else if (f.no === 15) for (const g of fields(buf, f.start, f.end)) if (g.no === 3 && g.varint !== undefined) statusCode = Number(g.varint);
	}
	return {
		traceId,
		name,
		statusCode,
		attr(key) {
			for (const kv of attrFields) {
				let k: string | null = null;
				let v: Field | null = null;
				for (const f of fields(buf, kv.start, kv.end)) {
					if (f.no === 1 && f.wire === LEN) k = text(buf, f);
					else if (f.no === 2 && f.wire === LEN) v = f;
				}
				if (k !== key || !v) continue;
				for (const g of fields(buf, v.start, v.end)) {
					if (g.no === 3 && g.varint !== undefined) return BigInt.asIntN(64, g.varint);
					if (g.no === 1 && g.wire === LEN) return text(buf, g);
				}
			}
			return undefined;
		}
	};
}

class Out {
	chunks: Uint8Array[] = [];
	length = 0;
	push(b: Uint8Array) {
		this.chunks.push(b);
		this.length += b.length;
	}
	varint(v: number) {
		const bytes: number[] = [];
		while (v >= 0x80) {
			bytes.push((v & 0x7f) | 0x80);
			v = Math.floor(v / 128);
		}
		bytes.push(v);
		this.push(Uint8Array.from(bytes));
	}
	field(no: number, body: Out | Uint8Array) {
		this.varint((no << 3) | LEN);
		this.varint(body.length);
		if (body instanceof Uint8Array) this.push(body);
		else for (const c of body.chunks) this.push(c);
	}
	bytes(): Uint8Array {
		const out = new Uint8Array(this.length);
		let o = 0;
		for (const c of this.chunks) {
			out.set(c, o);
			o += c.length;
		}
		return out;
	}
}

/**
 * Rebuild an ExportTraceServiceRequest with only the spans `keep` accepts.
 * Returns `null` when nothing is left, the input itself when everything was
 * kept. Other fields (resource, scope, schema urls) are copied verbatim.
 */
export function filterSpans(buf: Uint8Array, keep: (span: SpanFacts) => boolean): { bytes: Uint8Array | null; kept: number; dropped: number } {
	let kept = 0;
	let dropped = 0;
	const req = new Out();
	for (const top of fields(buf)) {
		if (top.no !== 1 || top.wire !== LEN) {
			req.push(buf.subarray(top.tagStart, top.end));
			continue;
		}
		const rs = new Out();
		let rsSpans = 0;
		for (const r of fields(buf, top.start, top.end)) {
			if (r.no !== 2 || r.wire !== LEN) {
				rs.push(buf.subarray(r.tagStart, r.end));
				continue;
			}
			const ss = new Out();
			let ssSpans = 0;
			for (const s of fields(buf, r.start, r.end)) {
				if (s.no !== 2 || s.wire !== LEN) {
					ss.push(buf.subarray(s.tagStart, s.end));
					continue;
				}
				if (keep(spanFacts(buf, s.start, s.end))) {
					ss.push(buf.subarray(s.tagStart, s.end));
					ssSpans++;
					kept++;
				} else dropped++;
			}
			if (ssSpans) {
				rs.field(2, ss);
				rsSpans += ssSpans;
			}
		}
		if (rsSpans) req.field(1, rs);
	}
	if (dropped === 0) return { bytes: kept ? buf : null, kept, dropped };
	return { bytes: kept ? req.bytes() : null, kept, dropped };
}

/** Deterministic trace-id based sampling decision (like TraceIDRatioBased). */
export function traceSampled(traceId: Uint8Array, ratio: number): boolean {
	if (ratio >= 1) return true;
	if (ratio <= 0 || traceId.length < 8) return false;
	// Use the last 8 bytes as an unsigned integer, compare to ratio × 2^64.
	let v = 0n;
	for (let i = traceId.length - 8; i < traceId.length; i++) v = (v << 8n) | BigInt(traceId[i]!);
	const bound = BigInt(Math.floor(ratio * 2 ** 53)) << 11n;
	return v < bound;
}
