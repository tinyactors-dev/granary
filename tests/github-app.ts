/**
 * Test helpers for the GitHub App surface (ADR 0164, ADR 0203): drive the
 * fake's manifest flow like a browser, sign app JWTs like granary's backend
 * will, and talk to the app-authenticated endpoints.
 */
import { createPrivateKey, sign } from 'node:crypto';
import type { Harness } from './harness';

export interface CreatedApp {
	id: number;
	slug: string;
	clientId: string;
	clientSecret: string;
	webhookSecret: string;
	pem: string;
	html_url: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 app JWT (iat 60 s in the past, like GitHub recommends). */
export function appJwt(appId: number | string, pem: string, opts: { iat?: number; exp?: number } = {}): string {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = b64url(JSON.stringify({ iat: opts.iat ?? now - 60, exp: opts.exp ?? now + 540, iss: appId }));
	const sig = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPrivateKey(pem));
	return `${header}.${payload}.${b64url(sig)}`;
}

/** The manifest granary sends (shape of GitHubAppManifest), pointing at `appUrl`. */
export function manifestFor(appUrl: string, name: string) {
	return {
		name,
		url: appUrl,
		hook_attributes: { url: `${appUrl}/webhook`, active: true },
		redirect_url: `${appUrl}/settings/github/callback`,
		callback_urls: [`${appUrl}/auth/callback`],
		setup_url: `${appUrl}/settings/github/installed`,
		public: false,
		default_permissions: { issues: 'write', metadata: 'read' },
		default_events: ['issues']
	};
}

/**
 * Create an app directly on the fake (manifest POST with auto=1, then the
 * conversion), bypassing granary. Returns the credentials GitHub hands out once.
 */
export async function createAppOnFake(h: Harness, name: string, owner = 'admin'): Promise<CreatedApp> {
	const form = new URLSearchParams({ manifest: JSON.stringify(manifestFor(h.appUrl, name)) });
	const res = await fetch(`${h.fakeUrl}/settings/apps/new?state=test-state&auto=1&login=${owner}`, {
		method: 'POST',
		body: form,
		redirect: 'manual'
	});
	if (res.status !== 302) throw new Error(`manifest POST: ${res.status} ${await res.text()}`);
	const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
	const conv = await fetch(`${h.fakeUrl}/app-manifests/${code}/conversions`, { method: 'POST' });
	if (conv.status !== 201) throw new Error(`conversion: ${conv.status} ${await conv.text()}`);
	const c = (await conv.json()) as { id: number; slug: string; client_id: string; client_secret: string; webhook_secret: string; pem: string; html_url: string };
	return { id: c.id, slug: c.slug, clientId: c.client_id, clientSecret: c.client_secret, webhookSecret: c.webhook_secret, pem: c.pem, html_url: c.html_url };
}

/** fetch against the fake with an app JWT. */
export function asApp(h: Harness, app: CreatedApp, path: string, init: RequestInit = {}) {
	return fetch(`${h.fakeUrl}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${appJwt(app.id, app.pem)}`, Accept: 'application/vnd.github+json', ...(init.headers ?? {}) }
	});
}

export async function installationToken(h: Harness, app: CreatedApp, installationId: number): Promise<{ token: string; expires_at: string }> {
	const r = await asApp(h, app, `/app/installations/${installationId}/access_tokens`, { method: 'POST' });
	if (r.status !== 201) throw new Error(`access_tokens: ${r.status} ${await r.text()}`);
	return (await r.json()) as { token: string; expires_at: string };
}

// ---------------------------------------------------------------------------
// granary side (ADR 0159, 0160, 0161)
// ---------------------------------------------------------------------------

const decodeEntities = (s: string) =>
	s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Cookie header value from a response's Set-Cookie headers. */
export function cookiesOf(res: Response): string {
	return res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
}

/**
 * Consume a login link like a browser (GET confirm page, POST it) and return
 * the session cookie plus where granary redirected (ADR 0161).
 */
export async function consumeLoginLink(h: Harness, linkUrl: string): Promise<{ cookie: string; location: string | null }> {
	const url = new URL(linkUrl);
	const path = `${url.pathname}${url.search}`;
	const page = await h.fetchApp(path);
	if (page.status !== 200) throw new Error(`login link page: ${page.status}`);
	const res = await h.fetchApp(path, {
		method: 'POST',
		headers: { Origin: h.appUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
		body: ''
	});
	const cookie = cookiesOf(res);
	if (!cookie.includes('granary_session=')) throw new Error(`login link POST: ${res.status}, no session cookie`);
	return { cookie, location: res.headers.get('location') };
}

/**
 * Walk the in-product setup: GET /settings/github as an admin, submit the
 * manifest form to the fake (auto-confirm), follow GitHub's redirect back to
 * granary's callback. Returns the app the fake created.
 */
export async function setupGitHubApp(h: Harness, cookie: string): Promise<{ appId: number; slug: string; callbackStatus: number; callbackLocation: string | null }> {
	const page = await h.fetchApp('/settings/github', { headers: { Cookie: cookie } });
	const html = await page.text();
	const manifest = /name="manifest"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*name="manifest"/.exec(html);
	const action = /<form[^>]*action="([^"]*\/settings\/apps\/new[^"]*)"/.exec(html);
	if (!manifest || !action) throw new Error(`no manifest form on /settings/github (status ${page.status})`);
	const postUrl = new URL(decodeEntities(action[1]!));
	postUrl.searchParams.set('auto', '1');
	postUrl.searchParams.set('login', 'admin');
	const created = await fetch(postUrl, {
		method: 'POST',
		body: new URLSearchParams({ manifest: decodeEntities((manifest[1] ?? manifest[2])!) }),
		redirect: 'manual'
	});
	if (created.status !== 302) throw new Error(`fake manifest POST: ${created.status} ${await created.text()}`);
	const back = new URL(created.headers.get('location')!);
	const cb = await h.fetchApp(`${back.pathname}${back.search}`, { headers: { Cookie: cookie } });
	const apps = (await h.fakeGithub.state()).apps ?? [];
	const app = apps[apps.length - 1]!;
	return { appId: app.id, slug: app.slug, callbackStatus: cb.status, callbackLocation: cb.headers.get('location') };
}

/** granary env with no GitHub config at all (setup happens in-product). */
export const APP_MODE_ENV: Record<string, string> = {
	GITHUB_TOKEN: '',
	GITHUB_WEBHOOK_SECRET: '',
	GITHUB_OAUTH_CLIENT_ID: '',
	GITHUB_OAUTH_CLIENT_SECRET: '',
	GRANARY_MASTER_KEY: 'b1'.repeat(32)
};

/**
 * Bring a fresh granary into app mode: login link for `admin` (CLI), manifest
 * setup, install on `account` (all repos). Returns the admin cookie and app.
 */
export async function setupAppMode(h: Harness, account: string): Promise<{ cookie: string; appId: number; slug: string }> {
	const { runCli } = await import('./harness');
	const link = await runCli(h, ['login-link', 'admin', '--json']);
	if (link.code !== 0) throw new Error(`login-link: ${link.stderr || link.stdout}`);
	const { cookie } = await consumeLoginLink(h, (JSON.parse(link.stdout) as { url: string }).url);
	const { appId, slug } = await setupGitHubApp(h, cookie);
	await h.fakeGithub.installApp(appId, { account });
	await h.waitFor(
		async () => {
			const s = JSON.parse((await runCli(h, ['github', 'status', '--json'])).stdout) as { installations?: { account: string }[] };
			return s.installations?.some((i) => i.account === account);
		},
		{ message: 'installation synced', timeout: 20_000 }
	);
	return { cookie, appId, slug };
}
