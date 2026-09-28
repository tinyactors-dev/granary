/**
 * Session remote functions (ADR 0031, ADR 0034).
 * OAuth itself is the plain routes `/auth/login?redirect=` and `/auth/callback`.
 */
import { command, getRequestEvent, query } from '$app/server';
import { clearSessionCookie, currentUser } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';
import type { SessionUser } from '$lib/schemas/api';

/** The signed-in user, or null when anonymous. Public. */
export const getCurrentUser = query(async (): Promise<SessionUser | null> => currentUser());

/**
 * Delete the session row and the cookie. Public (no-op when anonymous).
 * Commands cannot redirect: the UI calls `goto('/')` (or `invalidateAll()`) afterwards.
 */
export const logout = command(async (): Promise<{ ok: true }> => {
	const { locals, cookies, url } = getRequestEvent();
	const sessionId = locals.sessionId;
	if (sessionId) await withBackend((b) => b.deleteSession(sessionId));
	clearSessionCookie(cookies, url);
	locals.user = null;
	locals.sessionId = null;
	getCurrentUser().set(null);
	return { ok: true };
});
