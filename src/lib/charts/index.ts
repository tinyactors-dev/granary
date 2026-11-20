/**
 * Building SCXML charts in TypeScript for `@tinyactors/node` (ADR 0300).
 *
 * A chart is SCXML text with ECMAScript expressions. This module keeps the
 * text single-sourced with the TypeScript that surrounds it:
 *
 * - `scxml` is a tagged template whose interpolations are XML-escaped (so
 *   `cond="${'a < b && c'}"` is safe) unless wrapped in `raw`;
 * - `helpers` embeds TypeScript functions as the chart's helper functions.
 *   A helper must be self-contained: it may call other embedded helpers by
 *   name, but must not close over module scope (imports, constants). The
 *   function is written into the chart with `Function.prototype.toString`;
 *   a mistake shows as `error.execution` when the helper runs, and in the
 *   chart's `compileCharts` diagnostics when it does not parse;
 * - `reply` answers `actor.ask` (the asker is `_event.origin`); an
 *   exception in the expression becomes `{error, status: 500}` so the asker
 *   never waits for its timeout.
 */
import type { Source } from '@tinyactors/node';

const RAW = Symbol('raw');
export interface Raw {
	readonly [RAW]: string;
}

/** Text written into the chart as it is (already SCXML). */
export const raw = (text: string): Raw => ({ [RAW]: text });

/** XML-escape text for an attribute or element content. */
export const escapeXML = (text: string): string =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const render = (value: unknown): string => {
	if (value === null || value === undefined || value === false) return '';
	if (Array.isArray(value)) return value.map(render).join('');
	if (typeof value === 'object' && RAW in (value as object)) return (value as Raw)[RAW];
	return escapeXML(String(value));
};

/** SCXML text: interpolations are escaped unless `raw`; arrays are joined; null, undefined and false vanish. */
export function scxml(strings: TemplateStringsArray, ...values: unknown[]): Raw {
	let out = strings[0]!;
	for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]!;
	return raw(out);
}

/** A JavaScript literal of `value` for an `expr` attribute (JSON is valid ECMAScript). */
export const lit = (value: unknown): string => (value === undefined ? 'undefined' : JSON.stringify(value));

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type Helper = Function;

/** A chart-level `<script>` defining `name(...)` as each function, in a CDATA section. */
export function helpers(fns: Record<string, Helper>): Raw {
	const body = Object.entries(fns)
		.map(([name, fn]) => {
			if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`helpers: ${name} is not an identifier`);
			// A bundler that renames a function renames its references in the other helpers too, and the
			// chart would call the names given here: refuse at build time instead of failing in the chart.
			if (/^[A-Za-z_$][\w$]*$/.test(fn.name) && fn.name !== name && !/^on\d+$/.test(name))
				throw new Error(`helpers: ${name} is the function ${fn.name} (renamed by a bundler?)`);
			const source = fn.toString();
			if (source.includes(']]>')) throw new Error(`helpers: ${name} contains "]]>"`);
			return `function ${name}(...a) { return (${source}).apply(this, a); }`;
		})
		.join('\n');
	return raw(`<script><![CDATA[\n${body}\n]]></script>`);
}

/** The helper every chart gets: run `f`, and turn an exception into `{error, status: 500}`. */
function tryReply(f: () => unknown) {
	try {
		return f();
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e), status: 500 };
	}
}

/** `<send>` of `event` to whoever sent the current event (an `actor.ask`), with `expr` (JavaScript) as its data. */
export const reply = (expr: string, event = 'reply'): Raw =>
	scxml`<send event="${event}" targetexpr="_event.origin"><content expr="${`tryReply(() => (${expr}))`}"/></send>`;

/** One `<data>` per entry, each initialized to the JSON of its value. */
export const datamodel = (values: object): Raw =>
	scxml`<datamodel>${Object.entries(values).map(([id, v]) => scxml`<data id="${id}" expr="${lit(v)}"/>`)}</datamodel>`;

export interface ChartSpec {
	/** The chart's name (`<scxml name>`), which `host.spawn(name)` takes. */
	name: string;
	/** The first state; SCXML's default (the first child) when absent. */
	initial?: string;
	/** Helper functions, embedded as a chart-level script. */
	helpers?: Record<string, Helper>;
	/** Variables and their initial values (spawn `params` override them by id). */
	data?: object;
	/** The states, transitions and anything else inside `<scxml>`. */
	body: Raw;
}

/** The chart as a `compileCharts` source (`<name>.scxml`). */
export function chart(spec: ChartSpec): Source {
	const text = scxml`<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="${spec.name}"${spec.initial ? scxml` initial="${spec.initial}"` : ''}>
${helpers({ tryReply, ...(spec.helpers ?? {}) })}
${spec.data ? datamodel(spec.data) : ''}
${spec.body}
</scxml>`;
	return { name: `${spec.name}.scxml`, text: text[RAW] };
}

/**
 * A chart of request handlers over one state object (ADR 0300): the
 * variable `d` holds all of it, and each event's handler is
 * `(d, eventData) => result`, run in place (it may mutate `d`) and answered
 * to the asker. Spawn it with `params: { d: {...} }` to start from another
 * state. Handlers and their helpers must be self-contained (see `helpers`).
 */
export function handlerChart<D>(spec: {
	name: string;
	initial: D;
	handlers: Record<string, (d: D, e: any) => unknown>;
	helpers?: Record<string, Helper>;
}): Source {
	const handlerNames = Object.keys(spec.handlers).map((_, i) => `on${i}`);
	const fns: Record<string, Helper> = { ...(spec.helpers ?? {}) };
	Object.values(spec.handlers).forEach((fn, i) => (fns[handlerNames[i]!] = fn));
	return chart({
		name: spec.name,
		initial: 'ready',
		helpers: fns,
		data: { d: spec.initial },
		body: scxml`<state id="ready">${Object.keys(spec.handlers).map(
			(event, i) => scxml`<transition event="${event}">${reply(`${handlerNames[i]}(d, _event.data)`)}</transition>`
		)}</state>`
	});
}
