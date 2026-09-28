/**
 * OAuth login against the fake GitHub (ADR 0034): /auth/login → fake
 * authorize (?login= auto-approve) → /auth/callback → session cookie →
 * SSR page as that user.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { useHarness, type Harness } from './harness';

const h = useHarness();

beforeEach(async () => {
	await h().fakeGithub.reset();
});

/** Minimal cookie jar: name → value from Set-Cookie headers. */
function cookies(res: Response, jar: Map<string, string>) {
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(';');
		const eq = pair!.indexOf('=');
		const name = pair!.slice(0, eq).trim();
		const value = pair!.slice(eq + 1).trim();
		if (/expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0/i.test(c) || value === '') jar.delete(name);
		else jar.set(name, value);
	}
}
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function signIn(h: Harness, login: string, redirect = '/') {
	const jar = new Map<string, string>();
	const start = await h.fetchApp(`/auth/login?redirect=${encodeURIComponent(redirect)}`);
	expect(start.status).toBe(302);
	cookies(start, jar);
	expect(jar.has('granary_oauth_state')).toBe(true);
	const authorize = new URL(start.headers.get('location')!);
	expect(authorize.origin).toBe(h.fakeUrl);
	expect(authorize.pathname).toBe('/login/oauth/authorize');
	// Sign-in uses the GitHub App's own OAuth client (ADR 0160, 0230).
	const app = ((await h.fakeGithub.state()).apps ?? []).at(-1);
	expect(authorize.searchParams.get('client_id')).toBe(app?.clientId ?? '(no app)');
	expect(authorize.searchParams.get('redirect_uri')).toBe(`${h.appUrl}/auth/callback`);
	authorize.searchParams.set('login', login);

	const approved = await fetch(authorize, { redirect: 'manual' });
	expect(approved.status).toBe(302);
	const callback = new URL(approved.headers.get('location')!);
	expect(callback.origin + callback.pathname).toBe(`${h.appUrl}/auth/callback`);
	expect(callback.searchParams.get('state')).toBe(authorize.searchParams.get('state'));

	const done = await h.fetchApp(callback.pathname + callback.search, { headers: { cookie: cookieHeader(jar) } });
	cookies(done, jar);
	return { done, jar };
}

describe('OAuth login', () => {
	test(
		'admin signs in through the fake GitHub and sees the SSR dashboard',
		async () => {
			const { done, jar } = await signIn(h(), 'admin');
			expect([302, 303]).toContain(done.status);
			expect(new URL(done.headers.get('location')!, h().appUrl).pathname).toBe('/');
			expect(jar.has('granary_session')).toBe(true);
			const page = await h().fetchApp('/', { headers: { cookie: cookieHeader(jar) } });
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).toContain('admin');
		},
		60_000
	);

	test(
		'a non-admin login is refused with 403 and gets no session',
		async () => {
			const { done, jar } = await signIn(h(), 'mallory');
			expect(done.status).toBe(403);
			expect(jar.has('granary_session')).toBe(false);
		},
		60_000
	);

	test(
		'callback with a wrong state → 400',
		async () => {
			const jar = new Map<string, string>();
			const start = await h().fetchApp('/auth/login');
			cookies(start, jar);
			const res = await h().fetchApp('/auth/callback?code=whatever&state=not-the-state', {
				headers: { cookie: cookieHeader(jar) }
			});
			expect(res.status).toBe(400);
		},
		60_000
	);
});
