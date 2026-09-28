/**
 * Span naming for tinyactors spans (ADR 0155).
 *
 * tinyactors names every span `scxml.<kind>[ <detail>]` (e.g.
 * `scxml.macrostep issue.opened`). Exporters that know the actor's family
 * rename it to `<family> <kind>[ <detail>]` (e.g. `issue macrostep
 * issue.opened`): the family is low-cardinality, so it belongs in the span
 * name; the actor's name/address are high-cardinality and stay attributes.
 * The original name and the kind are kept as attributes so tooling never has
 * to parse names.
 *
 * Pure and dependency-free: used by the server tracer, the trace viewer and
 * the tests. (The ops module keeps its own copy, per the module boundary.)
 */

export const SPAN_NAME_ATTR = 'tinyactors.span.name';
export const SPAN_KIND_ATTR = 'tinyactors.span.kind';

const TINYACTORS = /^scxml\.([a-z_]+)(?: (.*))?$/s;

/** Kind and detail of an original tinyactors span name, or null for other spans. */
export function parseTinyactorsName(name: string): { kind: string; detail: string | null } | null {
	const m = TINYACTORS.exec(name);
	return m ? { kind: m[1]!, detail: m[2] ?? null } : null;
}

/** `scxml.macrostep issue.opened` + `issue` → `issue macrostep issue.opened`. */
export function familySpanName(original: string, family: string | null | undefined): string {
	const p = parseTinyactorsName(original);
	if (!p || !family) return original;
	return p.detail === null ? `${family} ${p.kind}` : `${family} ${p.kind} ${p.detail}`;
}

/**
 * Rename a decoded span in place and record `tinyactors.span.{name,kind}`.
 * Idempotent: a span that already carries `tinyactors.span.name` is left as is.
 */
export function applyFamilySpanName(span: { name: string; attributes: Record<string, unknown> }, family: string | null | undefined): void {
	if (typeof span.attributes[SPAN_NAME_ATTR] === 'string') return;
	const p = parseTinyactorsName(span.name);
	if (!p) return;
	span.attributes[SPAN_NAME_ATTR] = span.name;
	span.attributes[SPAN_KIND_ATTR] = p.kind;
	span.name = familySpanName(span.name, family);
}

/** The tinyactors kind of a span (`macrostep`, `finished`, …): attribute first, else parsed from an original name. */
export function spanKindOf(span: { name: string; attributes: Record<string, unknown> }): string | null {
	const k = span.attributes[SPAN_KIND_ATTR];
	if (typeof k === 'string') return k;
	return parseTinyactorsName(span.name)?.kind ?? null;
}

/** The original tinyactors name (`scxml.macrostep issue.opened`), or the span name for other spans. */
export function originalSpanName(span: { name: string; attributes: Record<string, unknown> }): string {
	const n = span.attributes[SPAN_NAME_ATTR];
	return typeof n === 'string' ? n : span.name;
}
