/**
 * JSON-safe copies of actor values for the inspector (ADR 0056, ADR 0300).
 *
 * What an actor holds is a value of tinyactors' value table (null,
 * booleans, numbers, bigints, strings, byte arrays, arrays and plain
 * objects), so only two things need care: bigint → decimal string, bytes →
 * `"[Uint8Array 12 bytes]"`. Depth, collection size and string length are
 * capped, with `"…"` markers.
 */
export interface JsonSafeLimits {
	maxDepth: number;
	maxEntries: number;
	maxString: number;
}

export const DEFAULT_LIMITS: JsonSafeLimits = { maxDepth: 12, maxEntries: 500, maxString: 8000 };

export function toJsonSafe(value: unknown, limits: Partial<JsonSafeLimits> = {}): unknown {
	const l = { ...DEFAULT_LIMITS, ...limits };
	const walk = (v: unknown, depth: number): unknown => {
		if (v === undefined || v === null) return null;
		if (typeof v === 'bigint') return v.toString();
		if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
		if (typeof v === 'string') return v.length > l.maxString ? `${v.slice(0, l.maxString)}… (${v.length} chars)` : v;
		if (typeof v !== 'object') return v;
		if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.byteLength} bytes]`;
		if (depth >= l.maxDepth) return '[…]';
		if (Array.isArray(v)) {
			const out = v.slice(0, l.maxEntries).map((x) => walk(x, depth + 1));
			if (v.length > l.maxEntries) out.push(`… ${v.length - l.maxEntries} more`);
			return out;
		}
		const out: Record<string, unknown> = {};
		const keys = Object.keys(v);
		for (const [n, k] of keys.entries()) {
			if (n >= l.maxEntries) {
				out['…'] = `${keys.length - l.maxEntries} more keys`;
				break;
			}
			out[k] = walk((v as Record<string, unknown>)[k], depth + 1);
		}
		return out;
	};
	return walk(value, 0);
}
