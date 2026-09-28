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
		// A browser form POST (Accept: text/html) gets the 303; `*/*` would get SvelteKit's JSON action result.
		headers: { Origin: h.appUrl, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
		body: ''
	});
	const cookie = cookiesOf(res);
	if (!cookie.includes('granary_session=')) throw new Error(`login link POST: ${res.status}, no session cookie`);
	return { cookie, location: res.headers.get('location') };
}

/** Remote-function ids (`<hash>/<name>`) found in the client chunks a page loads. */
async function remoteIds(h: Harness, cookie: string, pagePath: string): Promise<Map<string, string>> {
	const html = await (await h.fetchApp(pagePath, { headers: { Cookie: cookie } })).text();
	// SvelteKit emits relative asset paths (`../_app/immutable/…`) by default.
	const queue = [...html.matchAll(/["']((?:\.{1,2}\/)*\/?_app\/immutable\/[^"']+\.js)["']/g)].map((m) => new URL(m[1]!, `http://x${pagePath}`).pathname);
	const seen = new Set<string>();
	const ids = new Map<string, string>();
	while (queue.length && seen.size < 200) {
		const path = queue.shift()!;
		if (seen.has(path)) continue;
		seen.add(path);
		const js = await (await h.fetchApp(path)).text();
		for (const m of js.matchAll(/[`"']([a-z0-9]{4,12})\/([A-Za-z_$][\w$]*)[`"']/g)) ids.set(m[2]!, `${m[1]}/${m[2]}`);
		// Relative imports (`./x.js`, `../chunks/x.js`), resolved against this chunk's path.
		for (const m of js.matchAll(/["'`](\.{1,2}\/[\w./-]+\.js)["'`]/g)) queue.push(new URL(m[1]!, `http://x${path}`).pathname);
	}
	return ids;
}

/**
 * Call a SvelteKit remote `command` over HTTP exactly like the browser does
 * (`POST /_app/remote/<id>`, devalue payload, url-safe base64), as `cookie`.
 */
export async function remoteCommand<T>(h: Harness, cookie: string, pagePath: string, name: string, arg: unknown): Promise<T> {
	const devalue = await import('devalue');
	const id = (await remoteIds(h, cookie, pagePath)).get(name);
	if (!id) throw new Error(`remote function ${name} not found in the client chunks of ${pagePath}`);
	const payload = arg === undefined ? '' : Buffer.from(devalue.stringify(arg)).toString('base64url');
	const res = await h.fetchApp(`/_app/remote/${id}`, {
		method: 'POST',
		headers: {
			Cookie: cookie,
			Origin: h.appUrl,
			'Content-Type': 'application/json',
			'x-sveltekit-pathname': pagePath,
			'x-sveltekit-search': ''
		},
		body: JSON.stringify({ payload, refreshes: [] })
	});
	const body = (await res.json()) as { type: string; data?: string; error?: unknown; status?: number };
	if (!res.ok || body.type !== 'result') throw new Error(`${name}: ${res.status} ${JSON.stringify(body.error ?? body)}`);
	return (body.data ? (devalue.parse(body.data) as { _: T })._ : undefined) as T;
}

/**
 * Walk the in-product setup like the settings wizard: `beginGitHubAppManifest`
 * (remote command) → POST the manifest form to GitHub (the fake, auto-confirm)
 * → follow GitHub's redirect back to granary's callback. Returns the app.
 */
export async function setupGitHubApp(h: Harness, cookie: string): Promise<{ appId: number; slug: string; callbackStatus: number; callbackLocation: string | null }> {
	const form = await remoteCommand<{ postUrl: string; manifest: string; state: string }>(h, cookie, '/settings/github', 'beginGitHubAppManifest', {});
	const postUrl = new URL(form.postUrl);
	postUrl.searchParams.set('auto', '1');
	postUrl.searchParams.set('login', 'admin');
	const created = await fetch(postUrl, { method: 'POST', body: new URLSearchParams({ manifest: form.manifest }), redirect: 'manual' });
	if (created.status !== 302) throw new Error(`fake manifest POST: ${created.status} ${await created.text()}`);
	const back = new URL(created.headers.get('location')!);
	if (back.searchParams.get('state') !== form.state) throw new Error('state not echoed');
	const cb = await h.fetchApp(`${back.pathname}${back.search}`, { headers: { Cookie: cookie } });
	const apps = (await h.fakeGithub.state()).apps ?? [];
	const app = apps[apps.length - 1]!;
	return { appId: app.id, slug: app.slug, callbackStatus: cb.status, callbackLocation: cb.headers.get('location') };
}

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
