/**
 * Server hooks (ADR 0032, 0034, 0036).
 * - init: register the Backend (stub when GRANARY_STUB_BACKEND=1, else boot the real one).
 * - handle: fill locals.devMode / sessionId / user / setupState; health probes
 *   skip sessions; while setup is `needs-github`, admins land on
 *   /settings/github (ADR 0161, 0163).
 * The actor-system agent owns this file and may extend it.
 */
import { redirect, type Handle, type HandleValidationError, type ServerInit } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { loadConfig, isDevMode } from '$lib/schemas/config';
import { hasBackend, getBackend, setBackend } from '$lib/server/backend';
import { SESSION_COOKIE } from '$lib/server/auth';
import { hasOpsBackend, setOpsBackend } from '$lib/ops/contract';
import type { SetupState } from '$lib/schemas/admins';

/** Setup state changes rarely (GitHub connected); cache it briefly per process. */
const SETUP_TTL_MS = 2000;
let setupCache: { state: SetupState; at: number } | null = null;

async function setupState(): Promise<SetupState> {
	const now = Date.now();
	if (setupCache && now - setupCache.at < SETUP_TTL_MS) return setupCache.state;
	let state: SetupState = 'ready';
	try {
		state = (await getBackend().getSetupStatus()).state;
	} catch {
		/* backend not ready or not implemented: don't block the app */
	}
	setupCache = { state, at: now };
	return state;
}

/** Health probes: no session lookup, no setup redirects (ADR 0163). */
const PROBES = new Set(['/healthz', '/readyz']);

export const init: ServerInit = async () => {
	// /ops UI development without the real ops module (ADR 0110, 0140).
	if (env.GRANARY_STUB_OPS === '1' && !hasOpsBackend()) {
		const { createStubOpsBackend } = await import('$lib/ops/index');
		setOpsBackend(await createStubOpsBackend());
	}
	if (hasBackend()) return; // HMR: keep the running system
	const stub = env.GRANARY_STUB_BACKEND === '1';
	const config = loadConfig(env, { requireSecrets: !stub && !isDevMode({ dev, env }) });
	if (config.stubBackend) {
		const { StubBackend } = await import('$lib/server/backend.stub');
		setBackend(
			new StubBackend({
				admins: config.admins,
				dapPort: config.dapPort,
				fakeGithubUrl: config.fakeGithubUrl,
				...(config.origin ? { origin: config.origin } : {}),
				// Settings UI work (ADR 0210): GRANARY_STUB_GITHUB_MODE=none shows the setup wizard.
				...(env.GRANARY_STUB_GITHUB_MODE === 'none' || env.GRANARY_STUB_GITHUB_MODE === 'app' || env.GRANARY_STUB_GITHUB_MODE === 'token'
					? { githubMode: env.GRANARY_STUB_GITHUB_MODE }
					: {})
			})
		);
		return;
	}
	const { bootBackend } = await import('$lib/server/boot');
	setBackend(await bootBackend(config, { devMode: isDevMode({ dev, env }) }));
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.devMode = isDevMode({ dev, env });
	event.locals.sessionId = null;
	event.locals.user = null;
	event.locals.setupState = 'ready';
	if (PROBES.has(event.url.pathname)) return resolve(event);
	const sid = event.cookies.get(SESSION_COOKIE);
	if (sid && hasBackend()) {
		const user = await getBackend().resolveSession(sid);
		if (user) {
			event.locals.sessionId = sid;
			event.locals.user = user;
		}
	}
	if (event.url.pathname.startsWith('/__dev') && !event.locals.devMode) {
		return new Response('Not Found', { status: 404 });
	}
	if (hasBackend()) {
		event.locals.setupState = await setupState();
		// First run (ADR 0161): admins land on the GitHub setup page from `/`.
		if (event.locals.setupState === 'needs-github' && event.locals.user?.isAdmin && event.url.pathname === '/' && event.request.method === 'GET') {
			redirect(303, '/settings/github');
		}
	}
	return resolve(event);
};

export const handleValidationError: HandleValidationError = ({ issues }) => ({
	message: issues.map((i) => `${(i.path ?? []).map((p) => (typeof p === 'object' ? p.key : p)).join('.')}: ${i.message}`).join('; ')
});
