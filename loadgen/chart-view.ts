/**
 * A chart's structure for the dev portal (`ChartStructure`), read from the
 * SCXML text loadgen builds. A minimal stand-in: a small walk over the tags
 * of a well-formed document (no DTD, no entities beyond the five XML ones),
 * enough for the charts of `src/lib/charts`. Not an actor.
 */
import type { Source } from '@tinyactors/node';
import type { ChartState, ChartStateKind, ChartStructure, ChartTransition } from '../src/lib/schemas/api';

const unescape = (s: string) =>
	s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!);

const attrsOf = (text: string): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const m of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = unescape(m[2]!);
	return out;
};

const words = (s: string | undefined) => (s ?? '').split(/\s+/).filter(Boolean);
const short = (s: string) => {
	const one = s.replace(/\s+/g, ' ').trim();
	return one.length > 140 ? `${one.slice(0, 139)}…` : one;
};

const STATE_KINDS: Record<string, ChartStateKind> = { state: 'atomic', parallel: 'parallel', final: 'final', history: 'history_shallow' };

/** One line per executable-content element, e.g. `send gh.open via github`. */
function describe(tag: string, a: Record<string, string>): string | null {
	switch (tag) {
		case 'send': {
			const event = a.event ?? (a.eventexpr ? `{${short(a.eventexpr)}}` : '?');
			const via = a.type ? ` via ${a.type}` : '';
			const to = a.target ? ` to ${a.target}` : a.targetexpr ? ` to {${short(a.targetexpr)}}` : '';
			const delay = a.delay ? ` after ${a.delay}` : a.delayexpr ? ` after {${short(a.delayexpr)}}` : '';
			return `send ${event}${via}${to}${delay}`;
		}
		case 'assign':
			return `assign ${a.location} = ${short(a.expr ?? '…')}`;
		case 'raise':
			return `raise ${a.event}`;
		case 'cancel':
			return `cancel ${a.sendid ?? `{${a.sendidexpr}}`}`;
		case 'log':
			return `log ${a.label ?? ''}`.trim();
		case 'if':
			return `if ${short(a.cond ?? '')}`;
		case 'elseif':
			return `elseif ${short(a.cond ?? '')}`;
		case 'else':
			return 'else';
		case 'foreach':
			return `foreach ${a.item} in ${a.array}`;
		case 'script':
			return 'script';
		default:
			return null;
	}
}

/** The structure of `source` (one `<scxml>` document). */
export function chartView(source: Source, opts: { family: string; revision: string; sourceFile: string }): ChartStructure {
	const text = source.text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
	const root: ChartStructure = {
		family: opts.family,
		revision: opts.revision,
		name: null,
		sourceFile: opts.sourceFile,
		datamodel: 'ecmascript',
		initial: [],
		data: [],
		states: []
	};
	const states: ChartState[] = [];
	/** Where executable content goes: a transition's or a state's entry/exit list. */
	let actions: string[] | null = null;
	let depth = 0;
	/** The element depth at which `actions` was opened. */
	let actionsDepth = -1;
	/** Elements whose content is not executable (`<content>`, `<donedata>`, `<datamodel>`'s values). */
	let skipDepth = -1;

	for (const m of text.matchAll(/<(\/?)([\w:]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g)) {
		const [, closing, tag, attrText, selfClosing] = m as unknown as [string, string, string, string, string];
		if (closing) {
			depth--;
			if (depth < skipDepth) skipDepth = -1;
			if (depth < actionsDepth) {
				actions = null;
				actionsDepth = -1;
			}
			if (tag in STATE_KINDS) states.pop();
			continue;
		}
		const a = attrsOf(attrText);
		const parent = states.at(-1);
		if (tag === 'scxml') {
			root.name = a.name ?? null;
			root.datamodel = a.datamodel ?? root.datamodel;
			root.initial = words(a.initial);
		} else if (skipDepth >= 0) {
			/* inside content/donedata */
		} else if (tag === 'data') {
			if (states.length === 0 && a.id) root.data.push(a.id);
		} else if (tag in STATE_KINDS) {
			const s: ChartState = {
				id: a.id ?? '',
				kind: tag === 'history' && a.type === 'deep' ? 'history_deep' : STATE_KINDS[tag]!,
				initial: words(a.initial),
				transitions: [],
				onentry: [],
				onexit: [],
				invokes: [],
				source: null,
				children: []
			};
			if (parent) {
				parent.children.push(s);
				if (parent.kind === 'atomic') parent.kind = 'compound';
			} else root.states.push(s);
			if (!selfClosing) states.push(s);
		} else if (tag === 'transition' && parent) {
			const t: ChartTransition = {
				event: a.event ?? null,
				targets: words(a.target),
				kind: a.type === 'internal' ? 'internal' : 'external',
				condition: a.cond ? short(a.cond) : null,
				actions: [],
				source: null
			};
			parent.transitions.push(t);
			if (!selfClosing) {
				actions = t.actions;
				actionsDepth = depth + 1;
			}
		} else if ((tag === 'onentry' || tag === 'onexit') && parent && !selfClosing) {
			actions = tag === 'onentry' ? parent.onentry : parent.onexit;
			actionsDepth = depth + 1;
		} else if (tag === 'invoke' && parent) {
			parent.invokes.push(`invoke ${a.type ?? 'scxml'}${a.id ? ` id=${a.id}` : ''}`);
		} else if (tag === 'content' || tag === 'donedata' || tag === 'param') {
			if (!selfClosing) skipDepth = depth + 1;
		} else if (actions) {
			const line = describe(tag, a);
			if (line) actions.push(line);
		}
		if (!selfClosing) depth++;
	}
	if (!root.initial.length && root.states[0]) root.initial = [root.states[0].id];
	for (const s of all(root.states)) if (s.kind === 'compound' && !s.initial.length && s.children[0]) s.initial = [s.children[0].id];
	return root;
}

function* all(states: ChartState[]): Generator<ChartState> {
	for (const s of states) {
		yield s;
		yield* all(s.children);
	}
}
