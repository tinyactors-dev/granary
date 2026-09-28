/** Sizing rules for JsonBlock (ADR 0058). Pure; shared with the /__dev/ui story. */

export type JsonBlockPreset = 'inline' | 'compact' | 'panel';

export const PRESETS: Record<JsonBlockPreset, { expandDepth: number; maxRows: number; fixed: boolean }> = {
	/** Table cells, event rows: small, one level open. */
	inline: { expandDepth: 1, maxRows: 9, fixed: false },
	/** Cards: grows with the content up to ~20rem. */
	compact: { expandDepth: 2, maxRows: 15, fixed: false },
	/** Main data of a page: always 28rem. */
	panel: { expandDepth: 3, maxRows: 0, fixed: true }
};

export const ROW_PX = 22;
/**
 * Toolbar + status bar of JsonView, px, before it is measured. The toolbar
 * wraps to two rows in narrow containers, so JsonBlock measures the real
 * value after mount.
 */
export const CHROME_PX = 100;
export const PANEL_HEIGHT = '28rem';

/**
 * A value small enough to show as one line of code instead of a viewer:
 * a primitive, or a flat object/array of at most 3 primitives whose JSON is
 * at most 60 characters.
 */
export function isTiny(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return true;
	if (value instanceof Map || value instanceof Set) return false;
	const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
	if (entries.length > 3) return false;
	if (entries.some((v) => v !== null && typeof v === 'object')) return false;
	return oneLine(value).length <= 60;
}

export function oneLine(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (typeof value === 'bigint') return `${value}n`;
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Rows the structure view shows initially: nodes whose ancestors are all
 * expanded (containers shallower than expandDepth start open). Stops
 * counting at `cap`.
 */
export function initialRows(value: unknown, expandDepth: number, cap: number): number {
	let rows = 0;
	const seen = new Set<object>();
	const walk = (v: unknown, depth: number): void => {
		if (rows >= cap) return;
		rows++;
		if (v === null || typeof v !== 'object' || seen.has(v)) return;
		if (depth >= expandDepth && depth > 0) return;
		seen.add(v);
		const children = v instanceof Map ? [...v.values()] : v instanceof Set ? [...v] : Array.isArray(v) ? v : Object.values(v);
		for (const c of children) {
			walk(c, depth + 1);
			if (rows >= cap) return;
		}
	};
	walk(value, 0);
	return rows;
}

export function blockHeight(value: unknown, preset: JsonBlockPreset, expandDepth: number, chromePx = CHROME_PX): string {
	const p = PRESETS[preset];
	if (p.fixed) return PANEL_HEIGHT;
	const rows = Math.max(3, initialRows(value, expandDepth, p.maxRows));
	return `${rows * ROW_PX + chromePx}px`;
}
