/**
 * One-time sign-in links (ADR 0161). GET renders a confirm page only — link
 * previews and scanners must not consume the token. POST consumes it
 * atomically (single use, unexpired, login still an admin), creates a normal
 * session and redirects to the GitHub setup page while setup is incomplete.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getBackend, hasBackend } from '$lib/server/backend';
import { setSessionCookie } from '$lib/server/auth';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

export const load: PageServerLoad = ({ params, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
	return { wellFormed: TOKEN_RE.test(params.token) };
};

export const actions: Actions = {
	default: async ({ params, cookies, url }) => {
		if (!TOKEN_RE.test(params.token) || !hasBackend()) return fail(400, { error: 'This sign-in link is not valid.' });
		const backend = getBackend();
		const session = await backend.consumeLoginLink(params.token);
		if (!session) return fail(410, { error: 'This sign-in link is invalid, expired or already used. Ask for a new one with `granary login-link <login>`.' });
		setSessionCookie(cookies, session.sessionId, session.expiresAt, url);
		let target = '/';
		try {
			if ((await backend.getSetupStatus()).state === 'needs-github') target = '/settings/github';
		} catch {
			/* fall back to / */
		}
		redirect(303, target);
	}
};
