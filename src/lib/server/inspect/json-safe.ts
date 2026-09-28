/**
 * JSON-safe copies of arbitrary actor values for the inspector (ADR 0056).
 *
 * bigint → decimal string; Set → `{ "$set": [...] }`; Map → `{ "$map": {...} }`
 * (non-string keys are stringified); Date → ISO string; typed arrays →
 * `"[Uint8Array 12 bytes]"`; functions → `"[Function name]"`; symbols →
 * their description; errors → `{ name, message }`; cycles → `"[Circular]"`.
 * Depth, collection size and string length are capped, with `"…"` markers.
 */
export interface JsonSafeLimits {
	maxDepth: number;
	maxEntries: number;
	maxString: number;
}

export const DEFAULT_LIMITS: JsonSafeLimits = { maxDepth: 12, maxEntries: 500, maxString: 8000 };

export function toJsonSafe(value: unknown, limits: Partial<JsonSafeLimits> = {}): unknown {
	const l = { ...DEFAULT_LIMITS, ...limits };
	const seen = new WeakSet<object>();

	const walk = (v: unknown, depth: number): unknown => {
		switch (typeof v) {
			case 'undefined':
				return null;
			case 'boolean':
				return v;
			case 'number':
				return Number.isFinite(v) ? v : String(v);
			case 'bigint':
				return v.toString();
			case 'string':
				return v.length > l.maxString ? `${v.slice(0, l.maxString)}… (${v.length} chars)` : v;
			case 'symbol':
				return `[Symbol ${v.description ?? ''}]`;
			case 'function':
				return `[Function ${v.name || 'anonymous'}]`;
		}
		if (v === null) return null;
		const o = v as object;
		if (seen.has(o)) return '[Circular]';
		if (depth >= l.maxDepth) return '[…]';
		if (o instanceof Date) return Number.isNaN(o.getTime()) ? 'Invalid Date' : o.toISOString();
		if (ArrayBuffer.isView(o)) return `[${o.constructor.name} ${o.byteLength} bytes]`;
		if (o instanceof ArrayBuffer) return `[ArrayBuffer ${o.byteLength} bytes]`;
		if (o instanceof RegExp) return String(o);
		if (o instanceof Error) return { name: o.name, message: o.message };
		seen.add(o);
		try {
			if (Array.isArray(o)) return list(o, depth);
			if (o instanceof Set) return { $set: list([...o], depth) };
			if (o instanceof Map) {
				const out: Record<string, unknown> = {};
				let n = 0;
				for (const [k, x] of o) {
					if (n++ >= l.maxEntries) {
						out['…'] = `${o.size - l.maxEntries} more`;
						break;
					}
					out[typeof k === 'string' ? k : String(walk(k, depth + 1))] = walk(x, depth + 1);
				}
				return { $map: out };
			}
			const out: Record<string, unknown> = {};
			const keys = Object.keys(o);
			for (const [n, k] of keys.entries()) {
				if (n >= l.maxEntries) {
					out['…'] = `${keys.length - l.maxEntries} more keys`;
					break;
				}
				let x: unknown;
				try {
					x = (o as Record<string, unknown>)[k];
				} catch (e) {
					x = `[Getter threw: ${(e as Error)?.message ?? e}]`;
				}
				out[k] = walk(x, depth + 1);
			}
			return out;
		} finally {
			seen.delete(o);
		}
	};

	const list = (a: unknown[], depth: number): unknown[] => {
		const out = a.slice(0, l.maxEntries).map((x) => walk(x, depth + 1));
		if (a.length > l.maxEntries) out.push(`… ${a.length - l.maxEntries} more`);
		return out;
	};

	return walk(value, 0);
}
