/**
 * A minimal OTLP/protobuf encoder for `ExportTraceServiceRequest`, the
 * inverse of tinyactors' `decodeTraces` (ADR 0042). granary decodes each
 * trace batch, adds `granary.*` attributes (actor address, done-data) and
 * re-encodes it before posting to the collector.
 *
 * Not encoded (the decoder does not surface them): trace_state, span flags,
 * dropped counts, link flags, schema URLs.
 */
import type { DecodedSpan } from '@tinyactors/node';

class Writer {
	#chunks: number[] = [];

	get length(): number {
		return this.#chunks.length;
	}

	bytes(): Uint8Array {
		return Uint8Array.from(this.#chunks);
	}

	varint(value: number | bigint): void {
		let v = BigInt.asUintN(64, BigInt(value));
		while (v >= 0x80n) {
			this.#chunks.push(Number(v & 0x7fn) | 0x80);
			v >>= 7n;
		}
		this.#chunks.push(Number(v));
	}

	tag(field: number, wire: number): void {
		this.varint((field << 3) | wire);
	}

	raw(bytes: Uint8Array | number[]): void {
		for (const b of bytes) this.#chunks.push(b);
	}

	lengthDelimited(field: number, bytes: Uint8Array | number[]): void {
		this.tag(field, 2);
		this.varint(bytes.length);
		this.raw(bytes);
	}

	string(field: number, text: string): void {
		this.lengthDelimited(field, new TextEncoder().encode(text));
	}

	message(field: number, build: (w: Writer) => void): void {
		const inner = new Writer();
		build(inner);
		this.lengthDelimited(field, inner.bytes());
	}

	fixed64(field: number, value: bigint): void {
		this.tag(field, 1);
		const view = new DataView(new ArrayBuffer(8));
		view.setBigUint64(0, BigInt.asUintN(64, value), true);
		this.raw(new Uint8Array(view.buffer));
	}

	double(field: number, value: number): void {
		this.tag(field, 1);
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, value, true);
		this.raw(new Uint8Array(view.buffer));
	}

	uint(field: number, value: number): void {
		this.tag(field, 0);
		this.varint(value);
	}

	hexBytes(field: number, hex: string): void {
		const out: number[] = [];
		for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
		this.lengthDelimited(field, out);
	}
}

function anyValue(w: Writer, value: unknown): void {
	if (typeof value === 'string') w.string(1, value);
	else if (typeof value === 'boolean') w.uint(2, value ? 1 : 0);
	else if (typeof value === 'bigint') {
		w.tag(3, 0);
		w.varint(value);
	} else if (typeof value === 'number') {
		if (Number.isSafeInteger(value)) {
			w.tag(3, 0);
			w.varint(value);
		} else w.double(4, value);
	} else if (Array.isArray(value)) {
		w.message(5, (arr) => {
			for (const item of value) arr.message(1, (v) => anyValue(v, item));
		});
	} else if (value !== null && typeof value === 'object') {
		w.message(6, (kv) => keyValues(kv, 1, value as Record<string, unknown>));
	}
	// null / undefined: an empty AnyValue.
}

function keyValues(w: Writer, field: number, attrs: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(attrs)) {
		w.message(field, (kv) => {
			kv.string(1, key);
			kv.message(2, (v) => anyValue(v, value));
		});
	}
}

const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
const STATUS = ['unset', 'ok', 'error'];

function span(w: Writer, s: DecodedSpan): void {
	w.hexBytes(1, s.traceID);
	w.hexBytes(2, s.spanID);
	if (s.parentSpanID) w.hexBytes(4, s.parentSpanID);
	w.string(5, s.name);
	const kind = KINDS.indexOf(s.kind);
	if (kind > 0) w.uint(6, kind);
	w.fixed64(7, s.startTimeUnixNano);
	w.fixed64(8, s.endTimeUnixNano);
	keyValues(w, 9, s.attributes);
	for (const e of s.events) {
		w.message(11, (ev) => {
			ev.fixed64(1, e.timeUnixNano);
			ev.string(2, e.name);
			keyValues(ev, 3, e.attributes);
		});
	}
	for (const l of s.links) {
		w.message(13, (lw) => {
			lw.hexBytes(1, l.traceID);
			lw.hexBytes(2, l.spanID);
			keyValues(lw, 4, l.attributes);
		});
	}
	const code = STATUS.indexOf(s.status.code);
	if (code > 0 || s.status.message) {
		w.message(15, (st) => {
			if (s.status.message) st.string(2, s.status.message);
			if (code > 0) st.uint(3, code);
		});
	}
}

/**
 * Encodes spans as one `ExportTraceServiceRequest`. Spans are grouped by
 * their (shared) resource and scope objects, as `decodeTraces` returns them.
 */
export function encodeTraces(spans: readonly DecodedSpan[]): Uint8Array {
	const byResource = new Map<object, Map<object, DecodedSpan[]>>();
	for (const s of spans) {
		let scopes = byResource.get(s.resource);
		if (!scopes) byResource.set(s.resource, (scopes = new Map()));
		let list = scopes.get(s.scope);
		if (!list) scopes.set(s.scope, (list = []));
		list.push(s);
	}
	const w = new Writer();
	for (const [resource, scopes] of byResource) {
		w.message(1, (rs) => {
			rs.message(1, (r) => keyValues(r, 1, (resource as DecodedSpan['resource']).attributes));
			for (const [scope, list] of scopes) {
				rs.message(2, (ss) => {
					const sc = scope as DecodedSpan['scope'];
					ss.message(1, (s) => {
						s.string(1, sc.name);
						if (sc.version) s.string(2, sc.version);
					});
					for (const item of list) ss.message(2, (sw) => span(sw, item));
				});
			}
		});
	}
	return w.bytes();
}
