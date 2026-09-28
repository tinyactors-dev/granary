/**
 * `GET /settings/github/installed?installation_id&setup_action` — the GitHub
 * App's `setup_url`, where GitHub sends the user after installing or
 * changing the app (ADR 0160). For a signed-in admin the installations are
 * re-synced right away (the `installation` webhook does the same
 * asynchronously); everyone lands on Settings → GitHub (`?installed=1`,
 * or `?error=<message>` when the refresh failed, ADR 0211).
 */
import { redirect, type RequestHandler } from '@sveltejs/kit';
import { getBackend } from '$lib/server/backend';
import { log } from '$lib/server/log';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (locals.user?.isAdmin) {
		try {
			await getBackend().refreshGitHubInstallations(locals.user.login);
		} catch (e) {
			const message = (e as Error).message;
			log.warn(`github: refreshing installations after setup failed: ${message}`);
			redirect(303, `/settings/github?error=${encodeURIComponent(`Installed, but refreshing failed: ${message}`)}`);
		}
	}
	redirect(303, '/settings/github?installed=1');
};
