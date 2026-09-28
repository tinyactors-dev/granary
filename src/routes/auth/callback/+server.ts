/**
 * `GET /auth/callback?code&state` (ADR 0034): verify `state` against the
 * cookie (400), exchange the code, fetch `/user`, allow only ADMINS (403),
 * create a session, set `granary_session`, 303 to the stored redirect.
 * The GitHub access token is not stored.
 */
import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { isAdminLogin } from '$lib/schemas/config';
import { OAuthCallbackQuery } from '$lib/schemas/github';
import { check } from '$lib/schemas/standard';
import { OAUTH_STATE_COOKIE, safeRedirectPath, setSessionCookie } from '$lib/server/auth';
import { getBackend } from '$lib/server/backend';
import { getConfig } from '$lib/server/config';
import { OAuthFailure, decodeOAuthState, exchangeCode, fetchUser, sameState } from '$lib/server/oauth';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const config = getConfig();
	const query = Object.fromEntries(url.searchParams);
	if (!check(OAuthCallbackQuery, query)) error(400, 'Missing code or state');
	const stored = decodeOAuthState(cookies.get(OAUTH_STATE_COOKIE));
	if (!stored || !sameState(stored.state, query.state)) error(400, 'Invalid or expired sign-in state; please try again');
	cookies.delete(OAUTH_STATE_COOKIE, { path: '/auth', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:' });

	const origin = config.origin ?? url.origin;
	let user;
	try {
		const token = await exchangeCode(config, query.code, `${origin}/auth/callback`);
		user = await fetchUser(config, token);
	} catch (e) {
		if (e instanceof OAuthFailure) error(e.status, e.message);
		throw e;
	}
	if (!isAdminLogin(config, user.login)) error(403, `${user.login} is not allowed to sign in to granary`);

	const session = await getBackend().createSession({ login: user.login, avatarUrl: user.avatar_url });
	setSessionCookie(cookies, session.sessionId, session.expiresAt, url);
	redirect(303, safeRedirectPath(stored.redirect));
};
