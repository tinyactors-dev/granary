/**
 * Authorization helpers for remote functions and routes (ADR 0031, ADR 0034).
 *
 * `hooks.server.ts` (actor-system agent) fills `event.locals`:
 *   - `sessionId`: the `granary_session` cookie value if it resolved, else null
 *   - `user`:      `await getBackend().resolveSession(sessionId)` or null
 *   - `devMode`:   `isDevMode({ dev, env })` from `$lib/schemas/config`
 *
 * These helpers only read `getRequestEvent().locals`; call them first thing,
 * synchronously, inside a remote function.
 */
import { error } from '@sveltejs/kit';
import type { Cookies } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import type { SessionUser } from '$lib/schemas/api';
import { SESSION_TTL_MS } from '$lib/schemas/wal';

/** 401 unless signed in. */
export function requireUser(): SessionUser {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Sign in required');
	return locals.user;
}

/** 401 unless signed in, 403 unless the login is an admin (admins table). */
export function requireAdmin(): SessionUser {
	const user = requireUser();
	if (!user.isAdmin) error(403, 'Admins only');
	return user;
}

/** 404 unless dev mode is on (ADR 0009: dev surfaces pretend not to exist). */
export function requireDev(): void {
	const { locals } = getRequestEvent();
	if (!locals.devMode) error(404, 'Not Found');
}

/** The signed-in user or null (never throws). */
export function currentUser(): SessionUser | null {
	return getRequestEvent().locals.user;
}

// ---------------------------------------------------------------------------
// Session cookie (ADR 0034)
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'granary_session';
/** Short-lived cookie holding the OAuth `state` between /auth/login and /auth/callback. */
export const OAUTH_STATE_COOKIE = 'granary_oauth_state';
/** 30 days. */
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

/** Set `granary_session` (httpOnly, sameSite=lax, path=/, secure on https, expires at `expiresAt`). */
export function setSessionCookie(cookies: Cookies, sessionId: string, expiresAt: number, url: URL): void {
	cookies.set(SESSION_COOKIE, sessionId, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		expires: new Date(expiresAt)
	});
}

export function clearSessionCookie(cookies: Cookies, url: URL): void {
	cookies.delete(SESSION_COOKIE, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:'
	});
}

/**
 * A safe post-login redirect target: a same-origin absolute path, else `/`.
 * Used for `/auth/login?redirect=` and `devLoginAs.redirectTo`.
 */
export function safeRedirectPath(target: string | null | undefined): string {
	if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return '/';
	return target;
}
