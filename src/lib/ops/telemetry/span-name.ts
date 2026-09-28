/**
 * Span naming for the ops system's tinyactors spans (ADR 0155). A copy of
 * granary's `src/lib/trace/span-name.ts` rule, kept here because the ops
 * module must not import granary code (ADR 0080):
 * `scxml.<kind>[ <detail>]` → `<family> <kind>[ <detail>]`, with the original
 * name in `tinyactors.span.name` and the kind in `tinyactors.span.kind`.
 */
export const SPAN_NAME_ATTR = 'tinyactors.span.name';
export const SPAN_KIND_ATTR = 'tinyactors.span.kind';

const TINYACTORS = /^scxml\.([a-z_]+)(?: (.*))?$/s;

export function parseTinyactorsName(name: string): { kind: string; detail: string | null } | null {
	const m = TINYACTORS.exec(name);
	return m ? { kind: m[1]!, detail: m[2] ?? null } : null;
}

export function familySpanName(original: string, family: string | null | undefined): string {
	const p = parseTinyactorsName(original);
	if (!p || !family) return original;
	return p.detail === null ? `${family} ${p.kind}` : `${family} ${p.kind} ${p.detail}`;
}
