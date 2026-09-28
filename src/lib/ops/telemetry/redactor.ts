/**
 * Redaction registry (ADR 0093 rule 1, ADR 0121). I/O processors register
 * every secret value they reveal (via the backups feature's SecretReader);
 * the fan-out masks those values in every outgoing batch — as text for JSON
 * batches, and byte-for-byte (same length, '*') for protobuf, which keeps
 * length prefixes valid.
 */
import type { Redactor } from '../feature';

/** Values shorter than this are not registered (too likely to match innocent text). */
export const MIN_SECRET_LENGTH = 8;

const encoder = new TextEncoder();

interface Entry {
	value: string;
	bytes: Uint8Array;
	ref: string;
	expiresAt: number;
}

export class SecretRedactor implements Redactor {
	#entries = new Map<string, Entry>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	registerSecretValue(value: string, ref: string, ttlMs: number): void {
		if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
		const expiresAt = this.#now() + Math.max(0, ttlMs);
		const e = this.#entries.get(value);
		if (e) e.expiresAt = Math.max(e.expiresAt, expiresAt);
		else this.#entries.set(value, { value, bytes: encoder.encode(value), ref, expiresAt });
	}

	/** Number of values currently registered (for tests / stats). */
	get size(): number {
		this.#prune();
		return this.#entries.size;
	}

	#prune(): void {
		const now = this.#now();
		for (const [k, e] of this.#entries) if (e.expiresAt <= now) this.#entries.delete(k);
	}

	redact(text: string): string {
		this.#prune();
		let out = text;
		for (const e of this.#entries.values()) if (out.includes(e.value)) out = out.split(e.value).join('*'.repeat(e.value.length));
		return out;
	}

	/**
	 * Mask registered values in `bytes`. Returns the input when nothing
	 * matched, otherwise a masked copy (the input is never modified).
	 */
	maskBytes(bytes: Uint8Array): { bytes: Uint8Array; masked: number } {
		this.#prune();
		if (this.#entries.size === 0) return { bytes, masked: 0 };
		let out: Uint8Array | null = null;
		let masked = 0;
		for (const e of this.#entries.values()) {
			const hay = Buffer.from((out ?? bytes).buffer, (out ?? bytes).byteOffset, (out ?? bytes).byteLength);
			let i = hay.indexOf(e.bytes);
			while (i !== -1) {
				out ??= bytes.slice();
				out.fill(0x2a, i, i + e.bytes.length);
				masked++;
				const h2 = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
				i = h2.indexOf(e.bytes, i + e.bytes.length);
			}
		}
		return { bytes: out ?? bytes, masked };
	}
}
