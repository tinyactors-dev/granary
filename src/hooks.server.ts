/**
 * Server hooks (ADR 0032, 0034, 0036).
 * - init: register the Backend (stub when GRANARY_STUB_BACKEND=1, else boot the real one).
 * - handle: fill locals.devMode / sessionId / user.
 * The actor-system agent owns this file and may extend it.
 */
import type { Handle, HandleValidationError, ServerInit } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { loadConfig, isDevMode } from '$lib/schemas/config';
import { hasBackend, getBackend, setBackend } from '$lib/server/backend';
import { SESSION_COOKIE } from '$lib/server/auth';
import { hasOpsBackend, setOpsBackend } from '$lib/ops/contract';

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
			new StubBackend({ admins: config.admins, dapPort: config.dapPort, fakeGithubUrl: config.fakeGithubUrl })
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
	return resolve(event);
};

export const handleValidationError: HandleValidationError = ({ issues }) => ({
	message: issues.map((i) => `${(i.path ?? []).map((p) => (typeof p === 'object' ? p.key : p)).join('.')}: ${i.message}`).join('; ')
});
