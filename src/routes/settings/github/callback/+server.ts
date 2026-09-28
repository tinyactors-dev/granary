/**
 * `GET /settings/github/callback?code&state` — the GitHub App manifest flow's
 * redirect (ADR 0160). Admin only (the same admin who started it, checked
 * against the stored nonce). Exchanges the code for the new app's
 * credentials, stores them, switches to app mode, and sends the admin back
 * to Settings → GitHub to install the app: `?created=1`, or
 * `?error=<message>` when the code/state is rejected (ADR 0211).
 */
import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { BackendError, getBackend } from '$lib/server/backend';

const back = (q: string) => `/settings/github?${q}`;

export const GET: RequestHandler = async ({ url, locals }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state) redirect(303, back(`error=${encodeURIComponent('GitHub did not return a code; please try again')}`));
	if (!locals.user) redirect(303, `/auth/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
	if (!locals.user.isAdmin) error(403, 'Only admins can connect GitHub');

	try {
		await getBackend().completeGitHubAppManifest(code, state, locals.user.login);
	} catch (e) {
		if (e instanceof BackendError) redirect(303, back(`error=${encodeURIComponent(e.message)}`));
		throw e;
	}
	redirect(303, back('created=1'));
};
