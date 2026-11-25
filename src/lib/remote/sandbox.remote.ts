/**
 * Admin → Sandbox (ADR 0315): is a sandbox answering on this machine, enter
 * it, and otherwise how to set one up. Production admins only.
 */
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { requireAdminArea } from '$lib/server/auth';
import { getConfig } from '$lib/server/config';
import { probeSandbox, setSandboxCookie } from '$lib/server/sandbox-proxy';

export interface SandboxInfo {
	/** `self`: this instance is a sandbox; `off`: GRANARY_SANDBOX_URL is empty. */
	state: 'self' | 'off' | 'down' | 'not-a-sandbox' | 'up';
	url: string | null;
	version: string | null;
	error: string | null;
	/** This instance's origin, for `granary sandbox init --via`. */
	origin: string;
	/** Shell commands that set up a sandbox on this machine, one per entry. */
	setup: string[];
}

function setupCommands(origin: string, url: string | null): string[] {
	const port = url ? new URL(url).port || '80' : '3100';
	const portFlag = port === '3100' ? '' : ` --port ${port}`;
	return [
		'sudo install -d -o granary -g granary -m 0700 /var/lib/granary-sandbox',
		`sudo -u granary granary sandbox init --data /var/lib/granary-sandbox --via ${origin}${portFlag} --admins <your-github-login>`,
		'granary systemd-unit --unit sandbox --data /var/lib/granary-sandbox | sudo tee /etc/systemd/system/granary-sandbox.service',
		'sudo systemctl daemon-reload && sudo systemctl enable --now granary-sandbox'
	];
}

export const getSandboxInfo = query(async (): Promise<SandboxInfo> => {
	requireAdminArea();
	const config = getConfig();
	const { url } = getRequestEvent();
	const origin = url.origin;
	const base = { origin, setup: setupCommands(origin, config.sandboxUrl) };
	if (config.sandbox) return { ...base, state: 'self', url: null, version: null, error: null };
	const s = await probeSandbox(config.sandboxUrl);
	switch (s.state) {
		case 'off':
			return { ...base, state: 'off', url: null, version: null, error: null };
		case 'down':
			return { ...base, state: 'down', url: s.url, version: null, error: s.error };
		case 'not-a-sandbox':
			return { ...base, state: 'not-a-sandbox', url: s.url, version: null, error: null };
		case 'up':
			return { ...base, state: 'up', url: s.url, version: s.version, error: null };
	}
});

/**
 * Enter the sandbox: from now on this browser is served by the sandbox,
 * until "Back to production". Commands cannot redirect: the page reloads
 * into the sandbox's sign-in page afterwards.
 */
export const enterSandbox = command(async (): Promise<{ next: string }> => {
	const user = requireAdminArea();
	if (!user?.isAdmin) error(403, 'Admins only');
	const config = getConfig();
	if (config.sandbox) error(409, 'This already is the sandbox');
	const s = await probeSandbox(config.sandboxUrl);
	if (s.state !== 'up') error(409, 'No sandbox answers on this machine');
	const { cookies, url } = getRequestEvent();
	setSandboxCookie(cookies, url);
	return { next: '/admin/sessions' };
});
