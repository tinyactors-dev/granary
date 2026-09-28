/**
 * Chart structures for the inspector (ADR 0056).
 *
 * tinyactors' public API has no "export the definition" call (the debugger
 * uses a private core binding), so we keep what we already have: the
 * `DefinitionSpec` each actor file's builder produces. `chartFor(identity)`
 * rebuilds the spec of the known chart for that family (builders are pure),
 * checks the revision matches the running definition, and converts it into
 * a JSON-safe `ChartStructure`, cached per family+revision.
 */
import type {
	ActionSpec,
	DefinitionBuilder,
	DefinitionIdentity,
	DefinitionSpec,
	ExpressionSpec,
	StateSpec,
	TransitionSpec
} from '@tinyactors/node';
import type { ChartSource, ChartState, ChartStructure, ChartTransition } from '../../schemas/api';
import { allowlistChart } from '../actors/allowlist';
import { issueChart } from '../actors/issue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BUILDERS: Record<string, () => DefinitionBuilder<any>> = {
	issue: issueChart,
	allowlist: allowlistChart
};

const cache = new Map<string, ChartStructure | null>();

const revisionText = (r: string | Uint8Array): string =>
	typeof r === 'string' ? r : Buffer.from(r).toString('hex');

/** The chart structure of a running definition, or null when it is not one of ours. */
export function chartFor(identity: DefinitionIdentity): ChartStructure | null {
	const revision = revisionText(identity.revision);
	const key = `${identity.family}@${revision}`;
	if (cache.has(key)) return cache.get(key)!;
	let chart: ChartStructure | null = null;
	const build = BUILDERS[identity.family];
	if (build) {
		const spec = build().build();
		if (spec.identity && revisionText(spec.identity.revision) === revision) chart = toChart(spec, identity.family, revision);
	}
	cache.set(key, chart);
	return chart;
}

export function toChart(spec: DefinitionSpec, family: string, revision: string): ChartStructure {
	// Builder spans come from stack traces of the *running* code: under Vite
	// and in the bundled build they point at transformed lines, so they are
	// not shown per element (ADR 0056). The chart names its actor file instead.
	const sourceOf = (_span: number | undefined): ChartSource | null => null;

	const transition = (t: TransitionSpec): ChartTransition => ({
		event: t.event ?? null,
		targets: [...(t.targets ?? [])],
		kind: t.kind,
		condition: t.condition === undefined ? null : describeExpr(t.condition),
		actions: (t.actions ?? []).flatMap((a) => describeAction(a)),
		source: sourceOf(t.span)
	});

	const state = (s: StateSpec): ChartState => ({
		id: s.id,
		kind: s.kind,
		initial: [...(s.initial?.targets ?? [])],
		transitions: (s.transitions ?? []).map(transition),
		onentry: (s.onentry ?? []).flatMap((h) => h.actions.flatMap((a) => describeAction(a))),
		onexit: (s.onexit ?? []).flatMap((h) => h.actions.flatMap((a) => describeAction(a))),
		invokes: (s.invokes ?? []).map((i) => {
			const type = i.type?.kind === 'literal' ? i.type.literal : i.type ? '(expr)' : 'scxml';
			const id = i.id?.kind === 'literal' ? ` id=${i.id.literal}` : '';
			return `invoke ${type}${id}`;
		}),
		source: sourceOf(s.span),
		children: (s.states ?? []).map(state)
	});

	return {
		family,
		revision,
		name: spec.name ?? null,
		sourceFile: `src/lib/server/actors/${family}.ts`,
		datamodel: spec.datamodel ?? 'javascript',
		initial: [...(spec.initial?.targets ?? [])],
		data: (spec.data ?? []).map((d) => d.name),
		states: (spec.states ?? []).map(state)
	};
}

/** Short one-line source of a guard/expression. */
function describeExpr(e: ExpressionSpec): string {
	if (typeof e === 'string') return e;
	if (typeof e === 'function') {
		const src = String(e).replace(/\s+/g, ' ').trim();
		// `function () { return X; }` / `({ event }) => X` → X
		const body =
			/^function\s*[\w$]*\s*\([^)]*\)\s*\{\s*return\s+(.*?);?\s*\}$/.exec(src)?.[1] ??
			/^(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*(?!\{)(.*)$/.exec(src)?.[1] ??
			src;
		return body.length > 140 ? `${body.slice(0, 139)}…` : body;
	}
	return `literal ${JSON.stringify((e as { value: unknown }).value) ?? ''}`.slice(0, 140);
}

function str(a: { kind: 'literal'; literal: string } | { kind: 'expr'; expr: ExpressionSpec } | undefined): string | null {
	if (!a) return null;
	return a.kind === 'literal' ? a.literal : `{${describeExpr(a.expr)}}`;
}

function describeAction(a: ActionSpec): string[] {
	switch (a.kind) {
		case 'raise':
			return [`raise ${a.raise.event}`];
		case 'send': {
			const s = a.send;
			const event = s.event?.kind === 'name' ? s.event.name : s.event ? `{${describeExpr(s.event.expr)}}` : '?';
			const parts = [`send ${event}`];
			const to = str(s.target);
			if (to) parts.push(`to ${to}`);
			const via = str(s.type);
			if (via) parts.push(`via ${via}`);
			const delay = str(s.delay);
			if (delay) parts.push(`after ${delay}`);
			if (s.id?.kind === 'literal') parts.push(`id=${s.id.literal}`);
			return [parts.join(' ')];
		}
		case 'cancel':
			return [`cancel ${str(a.cancel.sendid)}`];
		case 'assign': {
			const loc = typeof a.assign.location === 'string' ? a.assign.location : '(location)';
			return [`assign ${loc}`];
		}
		case 'script':
			return ['script'];
		case 'log':
			return [`log${a.log.label ? ` ${a.log.label}` : ''}`];
		case 'if': {
			const c = a.conditional;
			return [
				`if ${describeExpr(c.condition)}`,
				...(c.then_actions ?? []).flatMap((x) => describeAction(x).map((l) => `  ${l}`)),
				...(c.else_actions?.length
					? ['else', ...c.else_actions.flatMap((x) => describeAction(x).map((l) => `  ${l}`))]
					: [])
			];
		}
		case 'foreach':
			return [`foreach ${a.foreach.item}`, ...(a.foreach.body ?? []).flatMap((x) => describeAction(x).map((l) => `  ${l}`))];
	}
}
