/**
 * Typed access to the root layout data (`+layout.server.ts`): the signed-in
 * user, whether dev mode is on (ADR 0050) and what the admin section may do
 * here (ADR 0290).
 */
import { page } from '$app/state';
import type { SessionUser } from '$lib/schemas/api';
import { adminCapabilities, type AdminCapabilities } from '$lib/schemas/admin';

export interface ShellData {
	user: SessionUser | null;
	devMode: boolean;
	admin: AdminCapabilities;
}

const NONE = adminCapabilities({ devMode: false, debugger: false, simulation: { fakeGithub: false, fakeInfra: false, loadgen: false } });

export function shellData(): ShellData {
	const data = page.data as Partial<ShellData>;
	return { user: data.user ?? null, devMode: data.devMode ?? false, admin: data.admin ?? NONE };
}

export const isAdmin = (): boolean => shellData().user?.isAdmin ?? false;

/** Whether the admin section is open to the current visitor (ADR 0290). */
export const canSeeAdmin = (s: ShellData = shellData()): boolean => s.devMode || (s.user?.isAdmin ?? false);
