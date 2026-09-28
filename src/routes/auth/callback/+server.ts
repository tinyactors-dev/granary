/**
 * `GET /auth/callback?code&state` (ADR 0034): verify `state` against the
 * cookie (400), exchange the code, fetch `/user`, allow only logins in the
 * admins table (403, ADR 0161/0220),
 * create a session, set `granary_session`, 303 to the stored redirect.
 * The GitHub access token is not stored.
 */
import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { OAuthCallbackQuery } from '$lib/schemas/github';
import { check } from '$lib/schemas/standard';
import { OAUTH_STATE_COOKIE, safeRedirectPath, setSessionCookie } from '$lib/server/auth';
import { getBackend } from '$lib/server/backend';
import { getConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import { OAuthFailure, decodeOAuthState, exchangeCode, fetchUser, oauthCredentials, sameState } from '$lib/server/oauth';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const config = getConfig();
	const query = Object.fromEntries(url.searchParams);
	if (!check(OAuthCallbackQuery, query)) error(400, 'Missing code or state');
	const stored = decodeOAuthState(cookies.get(OAUTH_STATE_COOKIE));
	if (!stored || !sameState(stored.state, query.state)) {
		log.warn('auth: GitHub sign-in rejected, invalid or expired state', { 'auth.method': 'github', 'auth.outcome': 'invalid-state' });
		error(400, 'Invalid or expired sign-in state; please try again');
	}
	cookies.delete(OAUTH_STATE_COOKIE, { path: '/auth', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:' });

	const origin = config.origin ?? url.origin;
	let user;
	try {
		const creds = await oauthCredentials();
		if (!creds) error(503, 'GitHub sign-in is not set up yet');
		const token = await exchangeCode(config, creds, query.code, `${origin}/auth/callback`);
		user = await fetchUser(config, token);
	} catch (e) {
		if (e instanceof OAuthFailure) {
			log.warn(`auth: GitHub sign-in failed: ${e.message}`, { 'auth.method': 'github', 'auth.outcome': 'oauth-failed', 'http.response.status_code': e.status });
			error(e.status, e.message);
		}
		throw e;
	}
	const backend = getBackend();
	const login = user.login.toLowerCase();
	if (!(await backend.listAdmins()).some((a) => a.login.toLowerCase() === login)) {
		log.warn(`auth: ${user.login} is not an admin, sign-in refused`, { 'auth.method': 'github', 'auth.outcome': 'not-admin', 'user.login': user.login });
		error(403, `${user.login} is not allowed to sign in to granary`);
	}

	const session = await backend.createSession({ login: user.login, avatarUrl: user.avatar_url });
	setSessionCookie(cookies, session.sessionId, session.expiresAt, url);
	log.info(`auth: ${user.login} signed in with GitHub`, { 'auth.method': 'github', 'auth.outcome': 'ok', 'user.login': user.login });
	redirect(303, safeRedirectPath(stored.redirect));
};
