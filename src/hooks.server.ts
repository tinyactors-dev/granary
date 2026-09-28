/**
 * Server hooks (ADR 0032, 0034, 0036).
 * - init: register the Backend (stub when GRANARY_STUB_BACKEND=1, else boot the real one).
 * - handle: fill locals.devMode / sessionId / user / setupState; health probes
 *   skip sessions; while setup is `needs-github`, admins land on
 *   /settings/github (ADR 0161, 0163).
 * The actor-system agent owns this file and may extend it.
 */
import { redirect, type Handle, type HandleServerError, type HandleValidationError, type ServerInit } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { loadConfig, isDevMode } from '$lib/schemas/config';
import { hasBackend, getBackend, setBackend } from '$lib/server/backend';
import { SESSION_COOKIE } from '$lib/server/auth';
import { hasOpsBackend, setOpsBackend } from '$lib/ops/contract';
import type { SetupState } from '$lib/schemas/admins';
import { adminCapabilities, isAdminPath, type AdminCapabilities } from '$lib/schemas/admin';
import { log } from '$lib/server/log';
import { observeRequest, safePath } from '$lib/server/request-log';

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

/** Admin-section capabilities (ADR 0290), from configuration; computed once. */
let capsCache: AdminCapabilities | null = null;
function capabilities(devMode: boolean): AdminCapabilities {
	if (capsCache && capsCache.devMode === devMode) return capsCache;
	let simulation = { fakeGithub: false, fakeInfra: false, loadgen: false };
	let debuggerOn = false;
	try {
		const config = loadConfig(env);
		simulation = config.simulation;
		debuggerOn = config.debugger;
	} catch {
		/* invalid config fails at boot; here, fall back to "nothing extra" */
	}
	capsCache = adminCapabilities({ devMode, debugger: debuggerOn, simulation });
	return capsCache;
}

/**
 * Moved pages (ADR 0290, 0291): the dev console became /admin, actor
 * internals moved into it, deliveries/effects/verdicts became Activity and
 * the allowlist + closing message became Policy. 308 keeps the method.
 */
function movedTo(path: string): string | null {
	if (path === '/__dev' || path.startsWith('/__dev/')) return '/admin' + path.slice('/__dev'.length);
	if (path === '/actors' || path.startsWith('/actors/')) return '/admin' + path;
	if (path === '/ops/actors') return '/admin/actors';
	if (path === '/deliveries' || path === '/effects' || path === '/verdicts') return '/activity';
	if (path === '/allowlist') return '/policy';
	if (path === '/settings/closing-message') return '/policy/closing-message';
	return null;
}

export const init: ServerInit = async () => {
	// /ops UI development without the real ops module (ADR 0110, 0140).
	if (env.GRANARY_STUB_OPS === '1' && !hasOpsBackend()) {
		const { createStubOpsBackend } = await import('$lib/ops/index');
		setOpsBackend(await createStubOpsBackend());
	}
	if (hasBackend()) return; // HMR: keep the running system
	const config = loadConfig(env);
	if (config.stubBackend) {
		const { StubBackend } = await import('$lib/server/backend.stub');
		setBackend(
			new StubBackend({
				admins: config.seedAdmins,
				dapPort: config.dapPort,
				fakeGithubUrl: config.fakeGithubUrl,
				...(config.origin ? { origin: config.origin } : {}),
				// Settings UI work (ADR 0210): GRANARY_STUB_GITHUB_MODE=none shows the setup wizard.
				...(env.GRANARY_STUB_GITHUB_MODE === 'none' || env.GRANARY_STUB_GITHUB_MODE === 'app'
					? { githubMode: env.GRANARY_STUB_GITHUB_MODE }
					: {})
			})
		);
		return;
	}
	const { bootBackend } = await import('$lib/server/boot');
	setBackend(await bootBackend(config, { devMode: isDevMode({ dev, env }) }));
};

/** Every request: access log + request span + log context (ADR 0234). */
export const handle: Handle = ({ event, resolve }) => observeRequest(event, () => handleRequest({ event, resolve }));

const handleRequest: Handle = async ({ event, resolve }) => {
	event.locals.devMode = isDevMode({ dev, env });
	event.locals.admin = capabilities(event.locals.devMode);
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
	const moved = movedTo(event.url.pathname);
	if (moved) return new Response(null, { status: 308, headers: { location: moved + event.url.search } });
	// The admin section (ADR 0290): admins everywhere; in development mode also
	// anonymous visitors (they sign in there). Signed-out visitors in production
	// get the sign-in page from the root layout; signed-in non-admins get 404.
	if (isAdminPath(event.url.pathname) && !event.locals.devMode) {
		if (event.url.pathname.startsWith('/admin/api/') && !event.locals.admin.devApi) return new Response('Not Found', { status: 404 });
		if (event.locals.user && !event.locals.user.isAdmin) return new Response('Not Found', { status: 404 });
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

/**
 * Unexpected errors (5xx) are logged with their stack (the access log records
 * every status); replaces SvelteKit's default console output, including its
 * `[404] GET /.env` lines for scanner traffic (ADR 0234).
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status >= 500) log.error(`unexpected error handling ${event.request.method} ${safePath(event.url)}`, error instanceof Error ? error : { 'error.message': String(error) }, { 'http.response.status_code': status });
	return { message: status >= 500 ? 'Internal Error' : message };
};

export const handleValidationError: HandleValidationError = ({ issues }) => ({
	message: issues.map((i) => `${(i.path ?? []).map((p) => (typeof p === 'object' ? p.key : p)).join('.')}: ${i.message}`).join('; ')
});
