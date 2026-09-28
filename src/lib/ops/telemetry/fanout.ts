/**
 * The telemetry fan-out (ADR 0085, 0093, 0107, 0121): the `TelemetrySink`
 * granary's Tracer writes to. For every batch it
 *   1. redacts — registered secret values byte-for-byte, then sensitive
 *      attribute keys (only when a cheap text scan suggests one is present);
 *   2. samples granary traces when the monthly volume cap requires it
 *      (errors and lifecycle spans are always kept);
 *   3. routes the batch to every enabled sink that wants its signal (ops'
 *      own telemetry only to sinks with `exportOps !== false`), by posting
 *      `telemetry.batch` to the sink's actor.
 * `write` never throws and never blocks: anything that fails is dropped
 * and counted.
 */
import type { TelemetryBatch, TelemetrySink, OpsLogger } from '../contract';
import type { TelemetrySinkConfig } from '../schemas/sinks';
import type { QueuedBatch } from '../io/otlp';
import { filterSpans, maskSensitiveAttributes, SENSITIVE_KEY, traceSampled } from './otlp-wire';
import type { SecretRedactor } from './redactor';
import type { Database } from 'bun:sqlite';

export const OPS_SERVICE = 'granary-ops';
/** tinyactors lifecycle spans are always kept when sampling (ADR 0099). */
const LIFECYCLE = new Set(['scxml.spawned', 'scxml.loaded', 'scxml.unloaded', 'scxml.finished', 'scxml.destroyed']);
export const MIN_SAMPLE_RATIO = 0.01;

export interface FanoutStats {
	written: number;
	dropped: number;
	droppedBytes: number;
	redactedValues: number;
	sampledOutSpans: number;
}

const month = (t: number) => new Date(t).toISOString().slice(0, 7);
const kvKey = (sinkId: string, m: string) => `telemetry:volume:${sinkId}:${m}`;

export class TelemetryFanout implements TelemetrySink {
	#sinks = new Map<string, TelemetrySinkConfig>();
	#ratio = 1;
	#stopped = false;
	readonly stats: FanoutStats = { written: 0, dropped: 0, droppedBytes: 0, redactedValues: 0, sampledOutSpans: 0 };
	/** sinkId → bytes delivered this month (mirrors kv, flushed periodically). */
	#volume = new Map<string, { month: string; bytes: number; dirty: boolean }>();

	constructor(
		private readonly deps: {
			redactor: SecretRedactor;
			post: (sinkId: string, batch: QueuedBatch) => boolean;
			db: Database;
			log: OpsLogger;
			now: () => number;
		}
	) {}

	setSinks(sinks: TelemetrySinkConfig[]): void {
		this.#sinks = new Map(sinks.filter((s) => s.enabled).map((s) => [s.id, s]));
	}

	get sampleRatio(): number {
		return this.#ratio;
	}

	set sampleRatio(r: number) {
		this.#ratio = Math.min(1, Math.max(MIN_SAMPLE_RATIO, r));
	}

	active(): boolean {
		return !this.#stopped && this.#sinks.size > 0;
	}

	/** Does any enabled sink take ops' own telemetry? (skips ops trace work when not) */
	wantsOps(): boolean {
		if (this.#stopped) return false;
		for (const s of this.#sinks.values()) if (s.exportOps !== false) return true;
		return false;
	}

	stop(): void {
		this.#stopped = true;
		this.flushVolume();
	}

	write(batch: TelemetryBatch): void {
		try {
			this.#write(batch);
		} catch (e) {
			this.stats.dropped++;
			this.stats.droppedBytes += batch.bytes?.length ?? 0;
			this.deps.log.warn('ops telemetry: dropped a batch the fan-out could not process', e instanceof Error ? e.message : e);
		}
	}

	#write(batch: TelemetryBatch): void {
		if (!this.active() || batch.bytes.length === 0) return;
		const isOps = batch.service === OPS_SERVICE;
		const targets = [...this.#sinks.values()].filter((s) => s.signals.includes(batch.signal) && (!isOps || s.exportOps !== false));
		if (!targets.length) return;
		let bytes = this.#redact(batch);
		if (!bytes) return;
		if (batch.signal === 'traces' && !isOps && this.#ratio < 1 && batch.contentType === 'application/x-protobuf') {
			const ratio = this.#ratio;
			const r = filterSpans(bytes, (s) => s.statusCode === 2 || LIFECYCLE.has(s.name) || traceSampled(s.traceId, ratio));
			this.stats.sampledOutSpans += r.dropped;
			if (!r.bytes) return;
			bytes = r.bytes;
		}
		this.stats.written++;
		const q: QueuedBatch = { signal: batch.signal, contentType: batch.contentType, bytes, service: batch.service };
		for (const s of targets) {
			if (!this.deps.post(s.id, q)) {
				this.stats.dropped++;
				this.stats.droppedBytes += bytes.length;
			}
		}
	}

	/** Redaction (ADR 0093): registered values, then sensitive keys. Returns null to drop. */
	#redact(batch: TelemetryBatch): Uint8Array | null {
		if (batch.contentType === 'application/json') {
			const text = new TextDecoder().decode(batch.bytes);
			const red = this.deps.redactor.redact(text);
			return red === text ? batch.bytes : new TextEncoder().encode(red);
		}
		const masked = this.deps.redactor.maskBytes(batch.bytes);
		let bytes = masked.bytes;
		this.stats.redactedValues += masked.masked;
		if (batch.signal !== 'metrics' && SENSITIVE_KEY.test(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'))) {
			const copy = bytes === batch.bytes ? bytes.slice() : bytes;
			try {
				this.stats.redactedValues += maskSensitiveAttributes(copy, batch.signal);
			} catch {
				return null; // malformed protobuf: never export what we can't inspect
			}
			bytes = copy;
		}
		return bytes;
	}

	// ---------------------------------------------------------------------
	// volume accounting (ADR 0107): bytes delivered per sink per month
	// ---------------------------------------------------------------------

	onDelivered(sinkId: string, bytes: number): void {
		const m = month(this.deps.now());
		let v = this.#volume.get(sinkId);
		if (!v || v.month !== m) {
			v = { month: m, bytes: this.#readVolume(sinkId, m), dirty: false };
			this.#volume.set(sinkId, v);
		}
		v.bytes += bytes;
		v.dirty = true;
	}

	volumeThisMonth(sinkId: string): number {
		const m = month(this.deps.now());
		const v = this.#volume.get(sinkId);
		return v && v.month === m ? v.bytes : this.#readVolume(sinkId, m);
	}

	#readVolume(sinkId: string, m: string): number {
		const r = this.deps.db.query('SELECT value FROM kv WHERE key = $k').get({ k: kvKey(sinkId, m) }) as { value: string } | null;
		return r ? Number(r.value) || 0 : 0;
	}

	flushVolume(): void {
		const now = this.deps.now();
		for (const [sinkId, v] of this.#volume) {
			if (!v.dirty) continue;
			this.deps.db
				.query('INSERT INTO kv (key, value, updated_at) VALUES ($k, $v, $now) ON CONFLICT(key) DO UPDATE SET value = $v, updated_at = $now')
				.run({ k: kvKey(sinkId, v.month), v: String(v.bytes), now });
			v.dirty = false;
		}
	}

	/**
	 * Keep each sink's projected monthly volume under its cap by lowering
	 * the sample ratio (ADR 0107). Returns the new ratio when it changed.
	 */
	adjustSampling(): { from: number; to: number; sinkId: string; projected: number; budget: number } | null {
		const now = this.deps.now();
		const d = new Date(now);
		const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
		const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
		const elapsed = Math.max(3_600_000, now - start); // don't extrapolate from minutes
		let worst: { sinkId: string; projected: number; budget: number; factor: number } | null = null;
		for (const s of this.#sinks.values()) {
			const used = this.volumeThisMonth(s.id);
			const projected = (used / elapsed) * (end - start);
			const factor = projected > 0 ? s.volumeBudgetBytesPerMonth / projected : Infinity;
			if (!worst || factor < worst.factor) worst = { sinkId: s.id, projected, budget: s.volumeBudgetBytesPerMonth, factor };
		}
		if (!worst) return null;
		const from = this.#ratio;
		let to = from;
		if (worst.factor < 1) to = Math.max(MIN_SAMPLE_RATIO, from * worst.factor * 0.9);
		else if (worst.factor > 1.5 && from < 1) to = Math.min(1, from * 1.25); // recover slowly
		if (Math.abs(to - from) < 0.005) return null;
		this.sampleRatio = to;
		return { from, to: this.#ratio, sinkId: worst.sinkId, projected: Math.round(worst.projected), budget: worst.budget };
	}
}
