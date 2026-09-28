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
