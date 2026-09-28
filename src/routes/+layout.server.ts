import type { LayoutServerLoad } from './$types';

/**
 * Shell data for every page (ADR 0050): who is signed in and whether dev
 * mode is on. Read straight from `locals` (filled by hooks.server.ts), so
 * the shell never needs a remote round-trip to decide what to show.
 */
export const load: LayoutServerLoad = ({ locals }) => ({
	user: locals.user,
	devMode: locals.devMode
});
