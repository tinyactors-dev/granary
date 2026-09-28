/**
 * In-process OTLP/HTTP collector for the tests (ADR 0007, ADR 0061).
 *
 * `POST /v1/traces` (protobuf) is decoded with tinyactors' `decodeTraces`;
 * `POST /v1/logs` (protobuf) with the small decoder below — tinyactors ships
 * no logs decoder, and the logs carry the `tinyactors.definition.registered`
 * records that map a span's numeric `scxml.definition` to its family.
 *
 * Every span/log is tagged with the `epoch` of its service at arrival: the
 * harness bumps the app's epoch before it restarts the app, so session ids
 * (which restart from the same values in a new process) stay distinct.
 */
import { decodeTraces, type DecodedSpan } from '@tinyactors/node';

export interface CollectedSpan extends DecodedSpan {
	/** `resource.attributes['service.name']` (e.g. `granary`, `fake-github`). */
	service: string;
	/** Process generation of that service (0, then +1 per harness restart). */
	epoch: number;
	/** Arrival order at the collector. */
	seq: number;
}

export interface DecodedLog {
	service: string;
	epoch: number;
	timeUnixNano: bigint;
	severityText: string;
	body: unknown;
	eventName: string;
	attributes: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Minimal protobuf reader (only what OTLP logs need)
// ---------------------------------------------------------------------------

class Reader {
	pos = 0;
	constructor(readonly buf: Uint8Array) {}
	get done() {
		return this.pos >= this.buf.length;
	}
	varint(): bigint {
		let result = 0n;
		let shift = 0n;
		for (;;) {
			const b = this.buf[this.pos++];
			if (b === undefined) throw new Error('truncated varint');
			result |= BigInt(b & 0x7f) << shift;
			if ((b & 0x80) === 0) return result;
			shift += 7n;
		}
	}
	fixed64(): bigint {
		const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getBigUint64(0, true);
		this.pos += 8;
		return v;
	}
	bytes(): Uint8Array {
		const len = Number(this.varint());
		const out = this.buf.subarray(this.pos, this.pos + len);
		this.pos += len;
		return out;
	}
	/** Iterate fields: (fieldNumber, wireType). Caller must consume the value. */
	*fields(): Generator<[number, number]> {
		while (!this.done) {
			const key = Number(this.varint());
			yield [key >>> 3, key & 7];
		}
	}
	skip(wire: number) {
		if (wire === 0) this.varint();
		else if (wire === 1) this.pos += 8;
		else if (wire === 2) this.bytes();
		else if (wire === 5) this.pos += 4;
		else throw new Error(`unsupported wire type ${wire}`);
	}
}

const text = new TextDecoder();

function toNumber(v: bigint): number | bigint {
	const signed = BigInt.asIntN(64, v);
	return signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(signed) : signed;
}

function anyValue(buf: Uint8Array): unknown {
	const r = new Reader(buf);
	let value: unknown = undefined;
	for (const [field, wire] of r.fields()) {
		if (field === 1 && wire === 2) value = text.decode(r.bytes());
		else if (field === 2 && wire === 0) value = r.varint() !== 0n;
		else if (field === 3 && wire === 0) value = toNumber(r.varint());
		else if (field === 4 && wire === 1) {
			const b = r.buf.slice(r.pos, r.pos + 8);
			r.pos += 8;
			value = new DataView(b.buffer).getFloat64(0, true);
		} else if (field === 5 && wire === 2) {
			const arr: unknown[] = [];
			const inner = new Reader(r.bytes());
			for (const [f, w] of inner.fields()) {
				if (f === 1 && w === 2) arr.push(anyValue(inner.bytes()));
				else inner.skip(w);
			}
			value = arr;
		} else if (field === 6 && wire === 2) {
			value = keyValueList(r.bytes());
		} else if (field === 7 && wire === 2) value = r.bytes().slice();
		else r.skip(wire);
	}
	return value;
}

function keyValue(buf: Uint8Array): [string, unknown] {
	const r = new Reader(buf);
	let key = '';
	let value: unknown;
	for (const [field, wire] of r.fields()) {
		if (field === 1 && wire === 2) key = text.decode(r.bytes());
		else if (field === 2 && wire === 2) value = anyValue(r.bytes());
		else r.skip(wire);
	}
	return [key, value];
}

function keyValueList(buf: Uint8Array): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const r = new Reader(buf);
	for (const [field, wire] of r.fields()) {
		if (field === 1 && wire === 2) {
			const [k, v] = keyValue(r.bytes());
			out[k] = v;
		} else r.skip(wire);
	}
	return out;
}

/** A log record as decoded, before the collector tags it. */
export type RawLog = Omit<DecodedLog, 'service' | 'epoch'> & { resourceAttributes: Record<string, unknown> };

/** Decode an OTLP `ExportLogsServiceRequest` (protobuf). */
export function decodeLogs(bytes: Uint8Array): RawLog[] {
	const out: RawLog[] = [];
	const req = new Reader(bytes);
	for (const [f1, w1] of req.fields()) {
		if (f1 !== 1 || w1 !== 2) {
			req.skip(w1);
			continue;
		}
		const rl = new Reader(req.bytes());
		let resourceAttributes: Record<string, unknown> = {};
		const scopes: Uint8Array[] = [];
		for (const [f2, w2] of rl.fields()) {
			if (f2 === 1 && w2 === 2) resourceAttributes = keyValueList(rl.bytes());
			else if (f2 === 2 && w2 === 2) scopes.push(rl.bytes());
			else rl.skip(w2);
		}
		for (const scope of scopes) {
			const sl = new Reader(scope);
			for (const [f3, w3] of sl.fields()) {
				if (f3 !== 2 || w3 !== 2) {
					sl.skip(w3);
					continue;
				}
				const lr = new Reader(sl.bytes());
				const log: RawLog = {
					resourceAttributes,
					timeUnixNano: 0n,
					severityText: '',
					body: undefined,
					eventName: '',
					attributes: {}
				};
				for (const [f, w] of lr.fields()) {
					if (f === 1 && w === 1) log.timeUnixNano = lr.fixed64();
					else if (f === 3 && w === 2) log.severityText = text.decode(lr.bytes());
					else if (f === 5 && w === 2) log.body = anyValue(lr.bytes());
					else if (f === 6 && w === 2) {
						const [k, v] = keyValue(lr.bytes());
						log.attributes[k] = v;
					} else if (f === 12 && w === 2) log.eventName = text.decode(lr.bytes());
					else lr.skip(w);
				}
				out.push(log);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export class Collector {
	readonly spans: CollectedSpan[] = [];
	readonly logs: DecodedLog[] = [];
	/** `${service}:${epoch}:${definitionId}` → family */
	readonly families = new Map<string, string>();
	readonly epochs = new Map<string, number>();
	readonly errors: string[] = [];
	private seq = 0;
	private server: ReturnType<typeof Bun.serve> | null = null;
	private listeners = new Set<() => void>();

	get url(): string {
		if (!this.server) throw new Error('collector not started');
		return `http://127.0.0.1:${this.server.port}`;
	}

	start() {
		this.server = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			fetch: async (req) => {
				const path = new URL(req.url).pathname;
				if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
				const bytes = new Uint8Array(await req.arrayBuffer());
				try {
					if (path === '/v1/traces') this.addTraces(bytes);
					else if (path === '/v1/logs') this.addLogs(bytes);
					else if (path === '/v1/metrics') {
						/* accepted and ignored */
					} else return new Response('not found', { status: 404 });
				} catch (e) {
					this.errors.push(`${path}: ${(e as Error).message}`);
					return new Response('bad request', { status: 400 });
				}
				return new Response(new Uint8Array(0), { headers: { 'Content-Type': 'application/x-protobuf' } });
			}
		});
	}

	stop() {
		this.server?.stop(true);
		this.server = null;
	}

	epochOf(service: string): number {
		return this.epochs.get(service) ?? 0;
	}

	/** Called by the harness before it restarts a service's process. */
	bumpEpoch(service: string) {
		this.epochs.set(service, this.epochOf(service) + 1);
	}

	/** Called on every arrival; returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	familyOf(span: CollectedSpan): string | undefined {
		const def = span.attributes['scxml.definition'];
		return def === undefined ? undefined : this.families.get(`${span.service}:${span.epoch}:${String(def)}`);
	}

	private addTraces(bytes: Uint8Array) {
		if (!bytes.byteLength) return;
		for (const span of decodeTraces(bytes)) {
			const service = String(span.resource.attributes['service.name'] ?? 'unknown');
			this.spans.push(Object.assign(span, { service, epoch: this.epochOf(service), seq: this.seq++ }));
		}
		this.notify();
	}

	private addLogs(bytes: Uint8Array) {
		if (!bytes.byteLength) return;
		for (const raw of decodeLogs(bytes)) {
			const { resourceAttributes, ...rest } = raw;
			const service = String(resourceAttributes['service.name'] ?? 'unknown');
			const log: DecodedLog = { ...rest, service, epoch: this.epochOf(service) };
			this.logs.push(log);
			const id = log.attributes['tinyactors.definition.id'];
			const family = log.attributes['tinyactors.definition.family'];
			if (id !== undefined && typeof family === 'string') {
				this.families.set(`${service}:${log.epoch}:${String(id)}`, family);
			}
		}
		this.notify();
	}

	private notify() {
		for (const l of this.listeners) l();
	}
}
