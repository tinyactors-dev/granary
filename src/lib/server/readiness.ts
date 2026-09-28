/**
 * Readiness for `/readyz` (ADR 0163): set by `boot.ts` once granary.sqlite is
 * open, the tinyactors system booted and the boot re-post finished.
 */
const KEY = Symbol.for('granary.readiness');
const g = globalThis as { [KEY]?: { startedAt: number; readyAt: number | null } };

const state = (g[KEY] ??= { startedAt: Date.now(), readyAt: null });

export function markReady(): void {
	state.readyAt ??= Date.now();
}

export function markNotReady(): void {
	state.readyAt = null;
}

export function isReady(): boolean {
	return state.readyAt !== null;
}

export function uptimeSeconds(): number {
	return Math.max(0, (Date.now() - state.startedAt) / 1000);
}
