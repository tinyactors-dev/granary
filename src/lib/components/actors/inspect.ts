/**
 * Actor inspector helpers (ADR 0056): links and a small JSON diff.
 */
export function actorHref(address: { family: string; name: string }): string {
	return `/actors/${encodeURIComponent(address.family)}/${encodeURIComponent(address.name)}`;
}

export interface DataChange {
	/** JSONPath-ish: `$.issue.title`, `$.logins[2]`. */
	path: string;
	kind: 'added' | 'removed' | 'changed';
	before?: unknown;
	after?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leaf-level differences between two JSON-safe values (at most `limit`). */
export function diffJson(before: unknown, after: unknown, limit = 200): DataChange[] {
	const out: DataChange[] = [];
	const walk = (a: unknown, b: unknown, path: string) => {
		if (out.length >= limit) return;
		if (Array.isArray(a) && Array.isArray(b)) {
			const n = Math.max(a.length, b.length);
			for (let i = 0; i < n; i++) {
				if (i >= a.length) out.push({ path: `${path}[${i}]`, kind: 'added', after: b[i] });
				else if (i >= b.length) out.push({ path: `${path}[${i}]`, kind: 'removed', before: a[i] });
				else walk(a[i], b[i], `${path}[${i}]`);
			}
			return;
		}
		if (isObj(a) && isObj(b)) {
			for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
				const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`;
				if (!(k in b)) out.push({ path: p, kind: 'removed', before: a[k] });
				else if (!(k in a)) out.push({ path: p, kind: 'added', after: b[k] });
				else walk(a[k], b[k], p);
			}
			return;
		}
		if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, kind: 'changed', before: a, after: b });
	};
	walk(before, after, '$');
	return out;
}

/** Compact one-line rendering of a JSON value. */
export function inlineJson(v: unknown, max = 80): string {
	const s = v === undefined ? 'undefined' : JSON.stringify(v);
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
