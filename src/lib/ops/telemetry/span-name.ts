/**
 * A span's tinyactors kind. 0.4.0 writes it natively as
 * `tinyactors.span.kind`; spans of granary's legacy tracer (until it is
 * ported) carry it only in their name, `scxml.<kind>[ <detail>]`.
 */
export const SPAN_KIND_ATTR = 'tinyactors.span.kind';

const TINYACTORS = /^scxml\.([a-z_]+)(?: (.*))?$/s;

/** `scxml.<kind>[ <detail>]` → its parts (the legacy fallback). */
export function parseTinyactorsName(name: string): { kind: string; detail: string | null } | null {
	const m = TINYACTORS.exec(name);
	return m ? { kind: m[1]!, detail: m[2] ?? null } : null;
}
