import type { LayoutServerLoad } from './$types';
import { getConfig } from '$lib/server/config';
import { SANDBOX_LEAVE_PATH, SANDBOX_VIA_HEADER } from '$lib/server/sandbox-proxy';

/**
 * Shell data for every page (ADR 0050): who is signed in, whether dev mode is
 * on and what the admin section may do here (ADR 0290). Read straight from
 * `locals` (filled by hooks.server.ts), so the shell never needs a remote
 * round-trip to decide what to show.
 */
export const load: LayoutServerLoad = ({ locals, request }) => ({
	user: locals.user,
	devMode: locals.devMode,
	admin: locals.admin,
	setupState: locals.setupState,
	/** ADR 0312: a sandbox instance (GitHub is the local fake); every page says so. */
	sandbox: getConfig().sandbox,
	/** ADR 0315: this sandbox is being used through production; the strip links back. */
	sandboxLeave: getConfig().sandbox && request.headers.get(SANDBOX_VIA_HEADER) === 'production' ? SANDBOX_LEAVE_PATH : null
});
