/**
 * Categorical colours for the trace explorer (ADR 0054): one fixed slot per
 * actor family, never cycled, so a filter never repaints a family. The CSS
 * variables are defined in TraceExplorer.svelte (light + dark steps from the
 * validated reference palette; error uses the reserved status red).
 */
const SLOTS: Record<string, string> = {
	issue: 'var(--trace-1)',
	allowlist: 'var(--trace-2)'
};

/** Families the legend shows, in slot order. */
export const LEGEND: { label: string; color: string }[] = [
	{ label: 'issue', color: SLOTS.issue! },
	{ label: 'allowlist', color: SLOTS.allowlist! },
	{ label: 'other actor', color: 'var(--trace-3)' },
	{ label: 'no actor', color: 'var(--trace-none)' }
];

export function familyColor(family: unknown): string {
	if (typeof family !== 'string' || !family) return 'var(--trace-none)';
	return SLOTS[family] ?? 'var(--trace-3)';
}
