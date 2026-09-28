/**
 * Typed access to the root layout data (`+layout.server.ts`): the signed-in
 * user and whether dev mode is on (ADR 0050).
 */
import { page } from '$app/state';
import type { SessionUser } from '$lib/schemas/api';

export interface ShellData {
	user: SessionUser | null;
	devMode: boolean;
}

export function shellData(): ShellData {
	const data = page.data as Partial<ShellData>;
	return { user: data.user ?? null, devMode: data.devMode ?? false };
}

export const isAdmin = (): boolean => shellData().user?.isAdmin ?? false;
