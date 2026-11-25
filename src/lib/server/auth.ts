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
import { env } from '$env/dynamic/private';
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

/**
 * The admin section (ADR 0290): admins in every environment (in development
 * mode also anonymous visitors, who sign in there). With `capability`, 404
 * unless that area is available here (e.g. a simulation service configured).
 */
export function requireAdminArea(capability?: import('$lib/schemas/admin').AdminCapability): SessionUser | null {
	const { locals } = getRequestEvent();
	if (!locals.devMode) {
		if (!locals.user) error(401, 'Sign in required');
		if (!locals.user.isAdmin) error(404, 'Not Found');
	}
	if (capability && !locals.admin[capability]) error(404, `Not available here: ${capability}`);
	return locals.user;
}

/** The signed-in user or null (never throws). */
export function currentUser(): SessionUser | null {
	return getRequestEvent().locals.user;
}

// ---------------------------------------------------------------------------
// Session cookie (ADR 0034)
// ---------------------------------------------------------------------------

/**
 * Production's own cookies. A sandbox names its cookies differently, because
 * production serves it on production's origin (ADR 0315).
 */
export const PRODUCTION_COOKIES = { session: 'granary_session', oauthState: 'granary_oauth_state' } as const;
const SANDBOX_COOKIES = { session: 'granary_sandbox_session', oauthState: 'granary_sandbox_oauth_state' } as const;
const cookieNames = () => (env.GRANARY_SANDBOX === '1' ? SANDBOX_COOKIES : PRODUCTION_COOKIES);
/** The session cookie of this instance. */
export const sessionCookieName = (): string => cookieNames().session;
/** Short-lived cookie holding the OAuth `state` between /auth/login and /auth/callback. */
export const oauthStateCookieName = (): string => cookieNames().oauthState;
/** 30 days. */
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

/** Set the session cookie (httpOnly, sameSite=lax, path=/, secure on https, expires at `expiresAt`). */
export function setSessionCookie(cookies: Cookies, sessionId: string, expiresAt: number, url: URL): void {
	cookies.set(sessionCookieName(), sessionId, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		expires: new Date(expiresAt)
	});
}

export function clearSessionCookie(cookies: Cookies, url: URL): void {
	cookies.delete(sessionCookieName(), {
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
