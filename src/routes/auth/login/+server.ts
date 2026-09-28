/**
 * `GET /auth/login?redirect=<path>` (ADR 0034): start the GitHub OAuth web
 * flow. Stores `{state, redirect}` in the `granary_oauth_state` cookie
 * (httpOnly, sameSite=lax, path=/auth, 10 min) and redirects to
 * `${GITHUB_WEB_URL}/login/oauth/authorize` with the connection's OAuth
 * client (the GitHub App's in app mode, ADR 0160); 503 before setup.
 */
import { randomBytes } from 'node:crypto';
import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { OAUTH_STATE_COOKIE, safeRedirectPath } from '$lib/server/auth';
import { getConfig } from '$lib/server/config';
import { encodeOAuthState, oauthCredentials } from '$lib/server/oauth';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const config = getConfig();
	const creds = await oauthCredentials(config);
	if (!creds) error(503, 'GitHub sign-in is not set up yet. An admin can sign in with a link from `granary login-link <login>`.');
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
	authorize.searchParams.set('client_id', creds.clientId);
	authorize.searchParams.set('redirect_uri', `${origin}/auth/callback`);
	authorize.searchParams.set('state', state);
	redirect(302, authorize.toString());
};
