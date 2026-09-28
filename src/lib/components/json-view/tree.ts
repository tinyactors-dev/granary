/**
 * Pure data layer of <JsonView>: flattens any value into a pre-order node
 * table (no deep clone — nodes reference the caller's values), computes the
 * visible rows for a mode, formats paths and searches keys/values.
 *
 * Node 0 is the root. Node `n`'s subtree is `n .. end[n]-1`; its children are
 * found by `c = n + 1; c < end[n]; c = end[c]`.
 */

export type JsonPath = (string | number)[];

export type NodeKind =
	| 'object'
	| 'array'
	| 'string'
	| 'number'
	| 'boolean'
	| 'null'
	| 'bigint'
	| 'undefined'
	| 'other';

export interface JsonTree {
	readonly size: number;
	readonly root: unknown;
	readonly keys: (string | number | null)[];
	readonly values: unknown[];
	readonly kinds: NodeKind[];
	/** 'Set' | 'Map' | 'Circular' | 'Date' … — a badge for special shapes. */
	readonly tags: (string | null)[];
	readonly depth: Int32Array;
	readonly parent: Int32Array;
	/** Exclusive end of the node's subtree in pre-order. */
	readonly end: Int32Array;
	/** Number of direct children. */
	readonly count: Int32Array;
	/** Position among siblings. */
	readonly sibling: Int32Array;
	/** 1-based line of the node in the fully expanded pretty-printed document. */
	readonly line: Int32Array;
	/** 1-based closing-bracket line, or -1 (leaf / empty container). */
	readonly closeLine: Int32Array;
	readonly totalLines: number;
	/** Dot/bracket path, '' for the root (e.g. `items[3].name`). */
	readonly paths: string[];
	/** Mutable expansion state (1 = expanded). Bump a revision after changing it. */
	readonly expanded: Uint8Array;
	/** Lazily built lower-cased paths for search. */
	lowerPaths?: string[];
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function isContainer(kind: NodeKind): boolean {
	return kind === 'object' || kind === 'array';
}

/** Segment text as it appears in a dot/bracket path. */
export function formatSegment(key: string | number, first: boolean): string {
	if (typeof key === 'number') return `[${key}]`;
	if (IDENT.test(key)) return first ? key : `.${key}`;
	return `[${JSON.stringify(key)}]`;
}

export function formatPath(path: JsonPath): string {
	return path.map((k, i) => formatSegment(k, i === 0)).join('');
}

/** RFC 6901 JSON Pointer ('' for the root). */
export function toPointer(path: JsonPath): string {
	return path.map((k) => '/' + String(k).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

function kindOf(v: unknown): NodeKind {
	if (v === null) return 'null';
	switch (typeof v) {
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'bigint':
			return 'bigint';
		case 'undefined':
			return 'undefined';
		case 'object':
			if (Array.isArray(v) || v instanceof Set) return 'array';
			if (v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v)) return 'other';
			return 'object';
		default:
			return 'other';
	}
}

function tagOf(v: unknown): string | null {
	if (v instanceof Map) return 'Map';
	if (v instanceof Set) return 'Set';
	if (v instanceof Date) return 'Date';
	if (v === '[Circular]') return 'Circular';
	if (v && typeof v === 'object' && !Array.isArray(v)) {
		const keys = Object.keys(v);
		if (keys.length === 1) {
			const inner = (v as Record<string, unknown>)[keys[0]!];
			if (keys[0] === '$set' && Array.isArray(inner)) return 'Set';
			if (keys[0] === '$map' && inner && typeof inner === 'object') return 'Map';
		}
	}
	return null;
}

function entriesOf(v: unknown): [string | number, unknown][] {
	if (Array.isArray(v)) return v.map((x, i) => [i, x]);
	if (v instanceof Set) return [...v].map((x, i) => [i, x]);
	if (v instanceof Map) return [...v].map(([k, x]) => [typeof k === 'string' ? k : String(k), x]);
	return Object.keys(v as object).map((k) => [k, (v as Record<string, unknown>)[k]]);
}

/** Flatten `root`. Containers with depth < expandDepth start expanded. */
export function buildTree(root: unknown, expandDepth = 2): JsonTree {
	const keys: (string | number | null)[] = [];
	const values: unknown[] = [];
	const kinds: NodeKind[] = [];
	const tags: (string | null)[] = [];
	const paths: string[] = [];
	const depth: number[] = [];
	const parent: number[] = [];
	const end: number[] = [];
	const count: number[] = [];
	const sibling: number[] = [];
	const line: number[] = [];
	const closeLine: number[] = [];
	const ancestors = new Set<object>();
	let lineNo = 1;

	const visit = (key: string | number | null, v: unknown, d: number, p: number, s: number): void => {
		const n = keys.length;
		let kind = kindOf(v);
		let tag = tagOf(v);
		if ((kind === 'object' || kind === 'array') && ancestors.has(v as object)) {
			kind = 'other';
			tag = 'Circular';
			v = '[Circular]';
		}
		keys.push(key);
		values.push(v);
		kinds.push(kind);
		tags.push(tag);
		paths.push(key === null ? '' : paths[p]! + formatSegment(key, p === 0));
		depth.push(d);
		parent.push(p);
		end.push(n + 1);
		count.push(0);
		sibling.push(s);
		line.push(lineNo++);
		closeLine.push(-1);
		if (kind === 'object' || kind === 'array') {
			const entries = entriesOf(v);
			count[n] = entries.length;
			ancestors.add(v as object);
			entries.forEach(([k, x], i) => visit(k, x, d + 1, n, i));
			ancestors.delete(v as object);
			end[n] = keys.length;
			if (entries.length > 0) closeLine[n] = lineNo++;
		}
	};
	visit(null, root, 0, -1, 0);

	const size = keys.length;
	const expanded = new Uint8Array(size);
	for (let n = 0; n < size; n++) {
		if ((kinds[n] === 'object' || kinds[n] === 'array') && depth[n]! < Math.max(1, expandDepth)) expanded[n] = 1;
	}
	return {
		size,
		root,
		keys,
		values,
		kinds,
		tags,
		depth: Int32Array.from(depth),
		parent: Int32Array.from(parent),
		end: Int32Array.from(end),
		count: Int32Array.from(count),
		sibling: Int32Array.from(sibling),
		line: Int32Array.from(line),
		closeLine: Int32Array.from(closeLine),
		totalLines: lineNo - 1,
		paths,
		expanded
	};
}

export function pathOf(t: JsonTree, n: number): JsonPath {
	const out: JsonPath = [];
	for (let m = n; m > 0; m = t.parent[m]!) out.push(t.keys[m]!);
	return out.reverse();
}

export function hasChildren(t: JsonTree, n: number): boolean {
	return isContainer(t.kinds[n]!) && t.count[n]! > 0;
}

export type ViewMode = 'structure' | 'source';

/** Visible rows. `close[i]` marks a closing-bracket line (source mode only). */
export interface Rows {
	readonly node: Int32Array;
	readonly close: Uint8Array;
	readonly length: number;
	/** Row index of each node's opening row, or -1 when hidden. */
	readonly rowOf: Int32Array;
}

export function computeRows(t: JsonTree, mode: ViewMode): Rows {
	const node: number[] = [];
	const close: number[] = [];
	const rowOf = new Int32Array(t.size).fill(-1);
	const src = mode === 'source';
	// Iterative pre-order walk that skips collapsed subtrees and emits closing rows.
	const stack: number[] = []; // open containers awaiting their closing row
	let n = 0;
	while (n < t.size) {
		while (stack.length && t.end[stack[stack.length - 1]!]! <= n) {
			const c = stack.pop()!;
			if (src) {
				node.push(c);
				close.push(1);
			}
		}
		rowOf[n] = node.length;
		node.push(n);
		close.push(0);
		if (hasChildren(t, n) && t.expanded[n]) {
			stack.push(n);
			n = n + 1;
		} else {
			n = t.end[n]!;
		}
	}
	while (stack.length) {
		const c = stack.pop()!;
		if (src) {
			node.push(c);
			close.push(1);
		}
	}
	return { node: Int32Array.from(node), close: Uint8Array.from(close), length: node.length, rowOf };
}

/** Expand every ancestor of `n`. Returns true if anything changed. */
export function reveal(t: JsonTree, n: number): boolean {
	let changed = false;
	for (let m = t.parent[n]!; m >= 0; m = t.parent[m]!) {
		if (!t.expanded[m]) {
			t.expanded[m] = 1;
			changed = true;
		}
	}
	return changed;
}

export function setAll(t: JsonTree, open: boolean, from = 0): void {
	for (let n = from; n < t.end[from]!; n++) {
		if (isContainer(t.kinds[n]!)) t.expanded[n] = open || n === 0 ? 1 : 0;
	}
	if (!open && from !== 0) t.expanded[from] = 0;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface Query {
	readonly raw: string;
	readonly lower: string;
	/** Lower-cased path segments of the query (`issue.user.login` → 3). */
	readonly segs: string[];
	/** The segment highlighted in a matching key. */
	readonly last: string;
}

export function parseQuery(raw: string): Query {
	let q = raw.trim();
	if (q.startsWith('$')) q = q.slice(1);
	let segs: string[];
	if (q.startsWith('/')) {
		segs = q
			.split('/')
			.slice(1)
			.map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
		q = formatPath(segs.map((s) => (/^\d+$/.test(s) ? Number(s) : s)));
	} else {
		segs = q.split(/[.[\]"']+/);
	}
	segs = segs.map((s) => s.toLowerCase()).filter(Boolean);
	const lower = q.replace(/^\./, '').toLowerCase();
	return { raw, lower, segs, last: segs[segs.length - 1] ?? lower };
}

function lowerPaths(t: JsonTree): string[] {
	return (t.lowerPaths ??= t.paths.map((p) => p.toLowerCase()));
}

/** Does node `n`'s *own key* take part in a match of `q`? */
export function keyMatches(t: JsonTree, n: number, q: Query): boolean {
	if (n === 0 || !q.lower) return false;
	const lp = lowerPaths(t)[n]!;
	const ownStart = t.paths[t.parent[n]!]!.length;
	const idx = lp.lastIndexOf(q.lower);
	if (idx >= 0 && idx + q.lower.length > ownStart) return true;
	// Fuzzy: query segments match ancestor keys in order (gaps allowed); the
	// last query segment must match this node's key.
	if (q.segs.length === 0) return false;
	let qi = q.segs.length - 1;
	if (!String(t.keys[n]).toLowerCase().includes(q.segs[qi]!)) return false;
	qi--;
	for (let m = t.parent[n]!; qi >= 0 && m > 0; m = t.parent[m]!) {
		if (String(t.keys[m]).toLowerCase().includes(q.segs[qi]!)) qi--;
	}
	return qi < 0;
}

export function valueMatches(t: JsonTree, n: number, q: Query): boolean {
	if (!q.raw.trim() || isContainer(t.kinds[n]!)) return false;
	return displayValue(t.values[n], t.kinds[n]!).toLowerCase().includes(q.raw.trim().toLowerCase());
}

/** Matching node ids in document order. */
export function search(t: JsonTree, raw: string, values: boolean): Int32Array {
	const q = parseQuery(raw);
	if (!q.lower && !(values && raw.trim())) return new Int32Array(0);
	const out: number[] = [];
	for (let n = 1; n < t.size; n++) {
		if (keyMatches(t, n, q) || (values && valueMatches(t, n, q))) out.push(n);
	}
	return Int32Array.from(out);
}

/** Split `text` into parts, marking the first case-insensitive occurrence of `needle`. */
export function highlight(text: string, needle: string): { text: string; hit: boolean }[] {
	if (!needle) return [{ text, hit: false }];
	const i = text.toLowerCase().indexOf(needle.toLowerCase());
	if (i < 0) return [{ text, hit: false }];
	return [
		{ text: text.slice(0, i), hit: false },
		{ text: text.slice(i, i + needle.length), hit: true },
		{ text: text.slice(i + needle.length), hit: false }
	].filter((p) => p.text);
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/** A primitive as plain text (strings unquoted). */
export function displayValue(v: unknown, kind: NodeKind): string {
	switch (kind) {
		case 'string':
			return v as string;
		case 'bigint':
			return `${v}n`;
		case 'undefined':
			return 'undefined';
		case 'null':
			return 'null';
		case 'other':
			if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
			if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
			if (typeof v === 'symbol') return v.toString();
			if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.byteLength} bytes]`;
			return String(v);
		default:
			return String(v);
	}
}

/** JSON.stringify that survives bigint, Map/Set and cycles. */
export function safeStringify(value: unknown, indent = 2): string {
	const seen = new WeakSet<object>();
	const out = JSON.stringify(
		value,
		function (_k, v: unknown) {
			if (typeof v === 'bigint') return v.toString();
			if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
			if (typeof v === 'symbol') return v.toString();
			if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), x]));
			if (v instanceof Set) return [...v];
			if (v && typeof v === 'object') {
				if (seen.has(v)) return '[Circular]';
				seen.add(v);
			}
			return v;
		},
		indent
	);
	return out ?? String(value);
}

/** What "copy value" puts on the clipboard: raw text for primitives, JSON for containers. */
export function copyableValue(t: JsonTree, n: number): string {
	const kind = t.kinds[n]!;
	if (isContainer(kind)) return safeStringify(t.values[n]);
	return displayValue(t.values[n], kind);
}
