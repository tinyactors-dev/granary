/**
 * SCXML text → JSON-safe ChartStructure (ADR 0056, ADR 0300), with no
 * knowledge of which charts exist — shared by the app inspector
 * (`charts.ts`) and the load generator's persona inspector (ADR 0071).
 *
 * The charts are SCXML that granary builds itself (`src/lib/charts`), so a
 * small reader for well-formed XML is enough: elements, attributes,
 * comments, CDATA and text.
 */
import type { Source } from '@tinyactors/node';
import type { ChartState, ChartStateKind, ChartStructure, ChartTransition } from '../../schemas/api';

interface Element {
	name: string;
	attrs: Record<string, string>;
	children: Element[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#[0-9]+|\w+);/gi, (m, e: string) =>
		e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m)
	);

/** Parse well-formed XML into its element tree (text content is dropped). */
export function parseXML(text: string): Element {
	const root: Element = { name: '#document', attrs: {}, children: [] };
	const stack: Element[] = [root];
	let i = 0;
	while (i < text.length) {
		const lt = text.indexOf('<', i);
		if (lt < 0) break;
		if (text.startsWith('<!--', lt)) {
			i = text.indexOf('-->', lt) + 3;
		} else if (text.startsWith('<![CDATA[', lt)) {
			i = text.indexOf(']]>', lt) + 3;
		} else if (text.startsWith('<?', lt)) {
			i = text.indexOf('?>', lt) + 2;
		} else if (text.startsWith('</', lt)) {
			stack.pop();
			i = text.indexOf('>', lt) + 1;
		} else {
			const tag = /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/.exec(text.slice(lt));
			if (!tag) throw new Error(`chart-structure: malformed XML at offset ${lt}`);
			const attrs: Record<string, string> = {};
			for (const m of tag[2]!.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]!] = unescape(m[2]!);
			const el: Element = { name: tag[1]!.replace(/^.*:/, ''), attrs, children: [] };
			stack[stack.length - 1]!.children.push(el);
			if (!tag[3]) stack.push(el);
			i = lt + tag[0].length;
		}
		if (i <= 0) break;
	}
	return root;
}

const words = (s: string | undefined) => (s ? s.trim().split(/\s+/).filter(Boolean) : []);
const short = (s: string) => {
	const one = s.replace(/\s+/g, ' ').trim();
	return one.length > 140 ? `${one.slice(0, 139)}…` : one;
};

/** One line per executable-content action, e.g. `assign phase`, `send github.close via github`. */
function describe(a: Element): string[] {
	switch (a.name) {
		case 'raise':
			return [`raise ${a.attrs.event ?? '?'}`];
		case 'send': {
			const parts = [`send ${a.attrs.event ?? (a.attrs.eventexpr ? `{${short(a.attrs.eventexpr)}}` : '?')}`];
			const to = a.attrs.target ?? (a.attrs.targetexpr ? `{${short(a.attrs.targetexpr)}}` : null);
			if (to) parts.push(`to ${to}`);
			if (a.attrs.type) parts.push(`via ${a.attrs.type}`);
			if (a.attrs.delay) parts.push(`after ${a.attrs.delay}`);
			// A computed delay (e.g. a persona's think time) reads better as a word than as its source.
			else if (a.attrs.delayexpr) parts.push('after (computed delay)');
			if (a.attrs.id) parts.push(`id=${a.attrs.id}`);
			return [parts.join(' ')];
		}
		case 'cancel':
			return [`cancel ${a.attrs.sendid ?? `{${short(a.attrs.sendidexpr ?? '')}}`}`];
		case 'assign':
			return [`assign ${a.attrs.location ?? '?'}`];
		case 'script':
			return ['script'];
		case 'log':
			return [`log${a.attrs.label ? ` ${a.attrs.label}` : ''}`];
		case 'if': {
			const out = [`if ${short(a.attrs.cond ?? '')}`];
			for (const c of a.children) {
				if (c.name === 'elseif') out.push(`elseif ${short(c.attrs.cond ?? '')}`);
				else if (c.name === 'else') out.push('else');
				else out.push(...describe(c).map((l) => `  ${l}`));
			}
			return out;
		}
		case 'foreach':
			return [`foreach ${a.attrs.item ?? '?'}`, ...a.children.flatMap((c) => describe(c).map((l) => `  ${l}`))];
		default:
			return [];
	}
}

const STATE_ELEMENTS = new Set(['state', 'parallel', 'final', 'history']);

function state(el: Element): ChartState {
	const children = el.children.filter((c) => STATE_ELEMENTS.has(c.name));
	const kind: ChartStateKind =
		el.name === 'parallel'
			? 'parallel'
			: el.name === 'final'
				? 'final'
				: el.name === 'history'
					? el.attrs.type === 'deep'
						? 'history_deep'
						: 'history_shallow'
					: children.length
						? 'compound'
						: 'atomic';
	const handlers = (name: string) => el.children.filter((c) => c.name === name).flatMap((h) => h.children.flatMap(describe));
	const initialElement = el.children.find((c) => c.name === 'initial')?.children.find((c) => c.name === 'transition');
	const initial = el.attrs.initial ? words(el.attrs.initial) : words(initialElement?.attrs.target);
	return {
		id: el.attrs.id ?? '',
		kind,
		initial: kind === 'compound' && !initial.length && children[0] ? [children[0].attrs.id ?? ''] : initial,
		transitions: el.children.filter((c) => c.name === 'transition').map(transition),
		onentry: handlers('onentry'),
		onexit: handlers('onexit'),
		invokes: el.children
			.filter((c) => c.name === 'invoke')
			.map((i) => `invoke ${i.attrs.type ?? (i.attrs.typeexpr ? '(expr)' : 'scxml')}${i.attrs.id ? ` id=${i.attrs.id}` : ''}`),
		source: null,
		children: children.map(state)
	};
}

function transition(t: Element): ChartTransition {
	return {
		event: t.attrs.event ?? null,
		targets: words(t.attrs.target),
		kind: t.attrs.type === 'internal' ? 'internal' : 'external',
		condition: t.attrs.cond === undefined ? null : short(t.attrs.cond),
		actions: t.children.flatMap(describe),
		source: null
	};
}

/** A short, stable name for one version of a chart's text. */
export function chartRevision(text: string): string {
	return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 12);
}

/** The structure of a chart from its SCXML source. */
export function toChart(source: Source, sourceFile: string): ChartStructure {
	const scxml = parseXML(source.text).children.find((c) => c.name === 'scxml');
	if (!scxml) throw new Error(`chart-structure: ${source.name} has no <scxml> element`);
	const states = scxml.children.filter((c) => STATE_ELEMENTS.has(c.name)).map(state);
	const name = scxml.attrs.name ?? null;
	return {
		family: name ?? source.name.replace(/\.scxml$/, ''),
		revision: chartRevision(source.text),
		name,
		sourceFile,
		datamodel: scxml.attrs.datamodel ?? 'null',
		initial: scxml.attrs.initial ? words(scxml.attrs.initial) : states[0] ? [states[0].id] : [],
		data: scxml.children.filter((c) => c.name === 'datamodel').flatMap((d) => d.children.filter((c) => c.name === 'data').map((c) => c.attrs.id ?? '')),
		states
	};
}
