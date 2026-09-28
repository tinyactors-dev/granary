import type { LayoutServerLoad } from './$types';

/**
 * Shell data for every page (ADR 0050): who is signed in, whether dev mode is
 * on and what the admin section may do here (ADR 0290). Read straight from
 * `locals` (filled by hooks.server.ts), so the shell never needs a remote
 * round-trip to decide what to show.
 */
export const load: LayoutServerLoad = ({ locals }) => ({
	user: locals.user,
	devMode: locals.devMode,
	admin: locals.admin,
	setupState: locals.setupState
});
