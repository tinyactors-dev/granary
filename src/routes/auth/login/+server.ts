/**
 * `GET /auth/login?redirect=<path>` (ADR 0034): start the GitHub OAuth web
 * flow. Stores `{state, redirect}` in the `granary_oauth_state` cookie
 * (httpOnly, sameSite=lax, path=/auth, 10 min) and redirects to
 * `${GITHUB_WEB_URL}/login/oauth/authorize`.
 */
import { randomBytes } from 'node:crypto';
import { redirect, type RequestHandler } from '@sveltejs/kit';
import { OAUTH_STATE_COOKIE, safeRedirectPath } from '$lib/server/auth';
import { getConfig } from '$lib/server/config';
import { encodeOAuthState } from '$lib/server/oauth';

export const GET: RequestHandler = ({ url, cookies }) => {
	const config = getConfig();
	const state = randomBytes(24).toString('base64url');
	const target = safeRedirectPath(url.searchParams.get('redirect'));
	cookies.set(OAUTH_STATE_COOKIE, encodeOAuthState({ state, redirect: target }), {
		path: '/auth',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600
	});
	const origin = config.origin ?? url.origin;
	const authorize = new URL(`${config.githubWebUrl}/login/oauth/authorize`);
	authorize.searchParams.set('client_id', config.oauthClientId);
	authorize.searchParams.set('redirect_uri', `${origin}/auth/callback`);
	authorize.searchParams.set('state', state);
	redirect(302, authorize.toString());
};
