/**
 * Span tree for the Jaeger-style timeline (ADR 0054). Pure functions.
 *
 * - Children hang off `parentSpanId`, sorted by start.
 * - A span whose parent is not in the trace (evicted from the buffer, or a
 *   step tinyactors never emits as a span) is grouped under a synthetic
 *   "missing parent" node per missing id.
 * - A trace may have several real roots (tinyactors: `scxml.spawned`,
 *   `bootstrap` and the first macrostep share one trace); all are top level.
 */
import type { SpanAttributeValue, SpanSummary } from '$lib/schemas/dev';

export interface TreeNode {
	/** spanId, or `missing:<parentId>` for a synthetic node. */
	key: string;
	span: SpanSummary | null;
	/** Set on synthetic nodes: the parent id that is not in the trace. */
	missingId: string | null;
	children: TreeNode[];
	start: number;
	end: number;
	/** Number of descendants. */
	size: number;
}

export interface TreeRow {
	node: TreeNode;
	depth: number;
	/** For drawing guides: is this the last child of its parent? */
	last: boolean;
}

export function buildTree(spans: readonly SpanSummary[]): TreeNode[] {
	const nodes = new Map<string, TreeNode>();
	for (const s of spans) {
		nodes.set(s.spanId, { key: s.spanId, span: s, missingId: null, children: [], start: s.start, end: s.end, size: 0 });
	}
	const roots: TreeNode[] = [];
	const missing = new Map<string, TreeNode>();
	for (const s of spans) {
		const node = nodes.get(s.spanId)!;
		const pid = s.parentSpanId;
		if (!pid) {
			roots.push(node);
		} else if (nodes.has(pid) && pid !== s.spanId) {
			nodes.get(pid)!.children.push(node);
		} else {
			let m = missing.get(pid);
			if (!m) {
				m = { key: `missing:${pid}`, span: null, missingId: pid, children: [], start: s.start, end: s.end, size: 0 };
				missing.set(pid, m);
				roots.push(m);
			}
			m.children.push(node);
			m.start = Math.min(m.start, s.start);
			m.end = Math.max(m.end, s.end);
		}
	}
	const finish = (n: TreeNode): number => {
		n.children.sort(byStart);
		n.size = n.children.reduce((acc, c) => acc + 1 + finish(c), 0);
		return n.size;
	};
	roots.sort(byStart);
	roots.forEach(finish);
	return roots;
}

const byStart = (a: TreeNode, b: TreeNode) => a.start - b.start || a.end - b.end;

/** Depth-first rows, skipping the children of collapsed keys. */
export function flatten(roots: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (n: TreeNode, depth: number, last: boolean) => {
		rows.push({ node: n, depth, last });
		if (collapsed.has(n.key)) return;
		n.children.forEach((c, i) => walk(c, depth + 1, i === n.children.length - 1));
	};
	roots.forEach((r, i) => walk(r, 0, i === roots.length - 1));
	return rows;
}

/** Keys of every node that has children (for "collapse all"). */
export function parentKeys(roots: readonly TreeNode[]): string[] {
	const out: string[] = [];
	const walk = (n: TreeNode) => {
		if (n.children.length) out.push(n.key);
		n.children.forEach(walk);
	};
	roots.forEach(walk);
	return out;
}

/** "12 µs", "3.4 ms", "1.20 s". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return '–';
	if (ms === 0) return '0';
	if (ms < 1) return `${Math.round(ms * 1000)} µs`;
	if (ms < 1000) return `${ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Evenly spaced "nice" tick offsets (ms) across [0, total]. */
export function ticks(total: number, count = 5): number[] {
	if (total <= 0) return [0];
	const raw = total / count;
	const pow = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
	const out: number[] = [];
	for (let t = 0; t <= total + step * 1e-9; t += step) out.push(t);
	return out;
}

/** An attribute value for display: JSON strings are parsed back. */
export function displayValue(v: SpanAttributeValue): { json: boolean; value: unknown } {
	if (typeof v === 'string') {
		const t = v.trim();
		if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
			try {
				return { json: true, value: JSON.parse(t) };
			} catch {
				// truncated (values are cut at 256 chars) — show as text
			}
		}
	}
	return { json: false, value: v };
}

export const ATTR = {
	family: 'granary.actor.family',
	address: 'granary.actor.address',
	event: 'scxml.event.name',
	entered: 'scxml.state.entered',
	state: 'scxml.state',
	final: 'scxml.final_state'
} as const;

/** A compact hint shown after the span name: "→ closing", "final: closed". */
export function spanHint(s: SpanSummary): string | null {
	const final = s.attributes[ATTR.final];
	if (typeof final === 'string') return `final: ${final}`;
	const entered = displayValue(s.attributes[ATTR.entered] ?? null);
	if (entered.json && Array.isArray(entered.value) && entered.value.length) return `→ ${entered.value.join(', ')}`;
	return null;
}

/** Short span name: drop the `scxml.` prefix. */
export const shortName = (name: string) => name.replace(/^scxml\./, '');
