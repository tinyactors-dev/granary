/**
 * Summaries of OTLP/HTTP export requests for assertions (ADR 0135): the
 * service name and span names / log bodies / metric names. Protobuf traces
 * use tinyactors' `decodeTraces`; protobuf logs and metrics use the small
 * field walker below; JSON (OTLP/JSON) is read structurally.
 */
import { decodeTraces } from '@tinyactors/node';

export type Signal = 'traces' | 'logs' | 'metrics';

export interface OtlpSummary {
	service: string | null;
	summary: string[];
}

const MAX_ITEMS = 50;
const MAX_LEN = 200;
const clip = (s: string) => (s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s);

// ---------------------------------------------------------------------------
// Protobuf walking
// ---------------------------------------------------------------------------

interface Field {
	no: number;
	wire: number;
	bytes?: Uint8Array;
	varint?: bigint;
}

function* fields(buf: Uint8Array): Generator<Field> {
	let pos = 0;
	const varint = (): bigint => {
		let result = 0n;
		let shift = 0n;
		for (;;) {
			const b = buf[pos++];
			if (b === undefined) throw new Error('truncated varint');
			result |= BigInt(b & 0x7f) << shift;
			if ((b & 0x80) === 0) return result;
			shift += 7n;
		}
	};
	while (pos < buf.length) {
		const tag = Number(varint());
		const no = tag >>> 3;
		const wire = tag & 7;
		if (wire === 0) yield { no, wire, varint: varint() };
		else if (wire === 1) {
			pos += 8;
			yield { no, wire };
		} else if (wire === 5) {
			pos += 4;
			yield { no, wire };
		} else if (wire === 2) {
			const len = Number(varint());
			const bytes = buf.subarray(pos, pos + len);
			pos += len;
			yield { no, wire, bytes };
		} else throw new Error(`unsupported wire type ${wire}`);
	}
}

const sub = (buf: Uint8Array, no: number) => [...fields(buf)].filter((f) => f.no === no && f.bytes).map((f) => f.bytes!);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** AnyValue → a display string (string, number, bool; others summarised). */
function anyValue(buf: Uint8Array): string {
	for (const f of fields(buf)) {
		if (f.no === 1 && f.bytes) return text(f.bytes);
		if (f.no === 2 && f.varint !== undefined) return String(f.varint !== 0n);
		if (f.no === 3 && f.varint !== undefined) return String(BigInt.asIntN(64, f.varint));
		if (f.no === 5) return '[array]';
		if (f.no === 6) return '{kvlist}';
		if (f.no === 7) return '<bytes>';
	}
	return '';
}

/** service.name from a Resource message. */
function serviceOf(resource: Uint8Array | undefined): string | null {
	if (!resource) return null;
	for (const kv of sub(resource, 1)) {
		const key = sub(kv, 1)[0];
		const value = sub(kv, 2)[0];
		if (key && value && text(key) === 'service.name') return anyValue(value);
	}
	return null;
}

function logsProto(buf: Uint8Array): OtlpSummary {
	let service: string | null = null;
	const out: string[] = [];
	for (const rl of sub(buf, 1)) {
		service ??= serviceOf(sub(rl, 1)[0]);
		for (const sl of sub(rl, 2)) {
			for (const rec of sub(sl, 2)) {
				const body = sub(rec, 5)[0];
				const event = sub(rec, 12)[0];
				const severity = sub(rec, 3)[0];
				const parts = [severity ? text(severity) : '', event ? text(event) : '', body ? anyValue(body) : ''].filter(Boolean);
				if (out.length < MAX_ITEMS) out.push(clip(parts.join(' ')));
			}
		}
	}
	return { service, summary: out };
}

function metricsProto(buf: Uint8Array): OtlpSummary {
	let service: string | null = null;
	const out: string[] = [];
	for (const rm of sub(buf, 1)) {
		service ??= serviceOf(sub(rm, 1)[0]);
		for (const sm of sub(rm, 2)) {
			for (const m of sub(sm, 2)) {
				const name = sub(m, 1)[0];
				if (name && out.length < MAX_ITEMS) out.push(clip(text(name)));
			}
		}
	}
	return { service, summary: out };
}

function tracesProto(buf: Uint8Array): OtlpSummary {
	const spans = decodeTraces(buf);
	const service = (spans[0]?.resource.attributes['service.name'] as string | undefined) ?? null;
	return { service, summary: spans.slice(0, MAX_ITEMS).map((s) => clip(s.name)) };
}

// ---------------------------------------------------------------------------
// OTLP/JSON
// ---------------------------------------------------------------------------

type J = Record<string, any>;
const jsonValue = (v: J | undefined): string =>
	v === undefined
		? ''
		: 'stringValue' in v
			? String(v.stringValue)
			: 'intValue' in v
				? String(v.intValue)
				: 'boolValue' in v
					? String(v.boolValue)
					: 'doubleValue' in v
						? String(v.doubleValue)
						: JSON.stringify(v);
const jsonService = (resource: J | undefined): string | null => {
	const kv = (resource?.attributes as J[] | undefined)?.find((a) => a.key === 'service.name');
	return kv ? jsonValue(kv.value) : null;
};

function fromJson(signal: Signal, doc: J): OtlpSummary {
	const [top, scopes, items] =
		signal === 'traces'
			? ['resourceSpans', 'scopeSpans', 'spans']
			: signal === 'logs'
				? ['resourceLogs', 'scopeLogs', 'logRecords']
				: ['resourceMetrics', 'scopeMetrics', 'metrics'];
	let service: string | null = null;
	const out: string[] = [];
	for (const r of (doc[top] as J[] | undefined) ?? []) {
		service ??= jsonService(r.resource);
		for (const s of (r[scopes] as J[] | undefined) ?? []) {
			for (const it of (s[items] as J[] | undefined) ?? []) {
				if (out.length >= MAX_ITEMS) break;
				out.push(clip(signal === 'logs' ? jsonValue(it.body) : String(it.name ?? '')));
			}
		}
	}
	return { service, summary: out };
}

/** Throws when the body does not decode as the signal's export request. */
export function summarize(signal: Signal, contentType: string, body: Uint8Array): OtlpSummary {
	if (contentType.includes('json')) return fromJson(signal, JSON.parse(text(body)) as J);
	if (signal === 'traces') return tracesProto(body);
	if (signal === 'logs') return logsProto(body);
	return metricsProto(body);
}
