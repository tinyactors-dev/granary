/**
 * The fake GitHub's App surface as a contract (ADR 0164, ADR 0203): what
 * granary's GitHub App backend (E3) can rely on. Runs against the running
 * fake; granary's own behaviour is covered in github-app.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { uniqueName, useHarness } from './harness';
import { appJwt, asApp, createAppOnFake, installationToken, manifestFor } from './github-app';

const TOKEN_TTL_MS = 3000;
const h = useHarness({ fakeEnv: { FAKE_GITHUB_INSTALLATION_TOKEN_TTL_MS: String(TOKEN_TTL_MS) } });

describe('manifest flow', () => {
	test('confirm page, then redirect with code and state; conversion is single use', async () => {
		const name = uniqueName('app');
		const form = new URLSearchParams({ manifest: JSON.stringify(manifestFor(h().appUrl, name)) });
		const page = await fetch(`${h().fakeUrl}/settings/apps/new?state=s1`, { method: 'POST', body: form });
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain(name);
		expect(html).toContain('/settings/apps/new/confirm');

		const confirm = await fetch(`${h().fakeUrl}/settings/apps/new/confirm`, {
			method: 'POST',
			body: new URLSearchParams({ manifest: JSON.stringify(manifestFor(h().appUrl, name)), state: 's1', owner: 'admin' }),
			redirect: 'manual'
		});
		expect(confirm.status).toBe(302);
		const loc = new URL(confirm.headers.get('location')!);
		expect(`${loc.origin}${loc.pathname}`).toBe(`${h().appUrl}/settings/github/callback`);
		expect(loc.searchParams.get('state')).toBe('s1');
		const code = loc.searchParams.get('code')!;

		const conv = await fetch(`${h().fakeUrl}/app-manifests/${code}/conversions`, { method: 'POST' });
		expect(conv.status).toBe(201);
		const c = (await conv.json()) as Record<string, unknown>;
		expect(c).toMatchObject({ name, owner: { login: 'admin' }, permissions: { issues: 'write', metadata: 'read' }, events: ['issues'] });
		for (const k of ['id', 'slug', 'client_id', 'client_secret', 'webhook_secret', 'pem', 'html_url']) expect(c[k]).toBeTruthy();
		expect(String(c.pem)).toStartWith('-----BEGIN RSA PRIVATE KEY-----'); // PKCS#1, like github.com
		expect(() => createPrivateKey(String(c.pem))).not.toThrow();

		const again = await fetch(`${h().fakeUrl}/app-manifests/${code}/conversions`, { method: 'POST' });
		expect(again.status).toBe(404);

		const state = await h().fakeGithub.state();
		expect(state.apps!.find((a) => a.id === c.id)).toMatchObject({ slug: c.slug, webhookUrl: `${h().appUrl}/webhook`, owner: 'admin' });
	});

	test('organization variant creates the app for the org', async () => {
		const form = new URLSearchParams({ manifest: JSON.stringify(manifestFor(h().appUrl, uniqueName('orgapp'))) });
		const res = await fetch(`${h().fakeUrl}/organizations/acme-org/settings/apps/new?auto=1&state=x`, { method: 'POST', body: form, redirect: 'manual' });
		expect(res.status).toBe(302);
		const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
		const c = (await (await fetch(`${h().fakeUrl}/app-manifests/${code}/conversions`, { method: 'POST' })).json()) as { owner: { login: string; type: string } };
		expect(c.owner).toMatchObject({ login: 'acme-org', type: 'Organization' });
	});
});

describe('app JWT', () => {
	test('GET /app with a valid JWT; bad JWTs are 401', async () => {
		const app = await createAppOnFake(h(), uniqueName('jwt'));
		const ok = await asApp(h(), app, '/app');
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ id: app.id, slug: app.slug, installations_count: 0 });

		const now = Math.floor(Date.now() / 1000);
		const with_ = (jwt: string) => fetch(`${h().fakeUrl}/app`, { headers: { Authorization: `Bearer ${jwt}` } });
		expect((await with_(appJwt(app.id, app.pem, { iat: now - 700, exp: now - 100 }))).status).toBe(401); // expired
		expect((await with_(appJwt(app.id, app.pem, { exp: now + 3600 }))).status).toBe(401); // > 10 min
		expect((await with_(appJwt(app.id, app.pem, { iat: now + 600 }))).status).toBe(401); // issued in the future
		const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
		expect((await with_(appJwt(app.id, other.privateKey))).status).toBe(401); // wrong key
		expect((await with_(appJwt(999, app.pem))).status).toBe(401); // unknown app
		expect((await with_(appJwt(app.clientId, app.pem))).status).toBe(200); // iss = client id is accepted
	});
});

describe('installations and tokens', () => {
	test('install selected repos; token lists them and only works for them; tokens expire', async () => {
		const app = await createAppOnFake(h(), uniqueName('inst'));
		const owner = uniqueName('acct');
		const inRepo = uniqueName('guarded');
		const outRepo = uniqueName('other');
		await h().fakeGithub.ensureRepo({ owner, name: outRepo });
		const { installationId } = await h().fakeGithub.installApp(app.id, { account: owner, repos: [`${owner}/${inRepo}`] });

		const installations = (await (await asApp(h(), app, '/app/installations')).json()) as { id: number; account: { login: string }; repository_selection: string }[];
		expect(installations).toEqual([expect.objectContaining({ id: installationId, account: expect.objectContaining({ login: owner }), repository_selection: 'selected' })]);

		const { token, expires_at } = await installationToken(h(), app, installationId);
		expect(token).toStartWith('ghs_');
		expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
		const auth = { Authorization: `token ${token}` };
		const repos = (await (await fetch(`${h().fakeUrl}/installation/repositories`, { headers: auth })).json()) as { total_count: number; repositories: { full_name: string }[] };
		expect(repos.repositories.map((r) => r.full_name)).toEqual([`${owner}/${inRepo}`]);

		const { number } = await h().fakeGithub.createIssue({ owner, repo: inRepo, author: 'mallory', title: 't' });
		const other = await h().fakeGithub.createIssue({ owner, repo: outRepo, author: 'mallory', title: 't' });
		expect((await fetch(`${h().fakeUrl}/repos/${owner}/${inRepo}/issues/${number}`, { headers: auth })).status).toBe(200);
		expect((await fetch(`${h().fakeUrl}/repos/${owner}/${outRepo}/issues/${other.number}`, { headers: auth })).status).toBe(404);

		// Comments made with an installation token are authored by <slug>[bot].
		const c = await fetch(`${h().fakeUrl}/repos/${owner}/${inRepo}/issues/${number}/comments`, {
			method: 'POST',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ body: 'hi' })
		});
		expect(c.status).toBe(201);
		expect(((await c.json()) as { user: { login: string; type: string } }).user).toMatchObject({ login: `${app.slug}[bot]`, type: 'Bot' });

		await Bun.sleep(TOKEN_TTL_MS + 300);
		expect((await fetch(`${h().fakeUrl}/repos/${owner}/${inRepo}/issues/${number}`, { headers: auth })).status).toBe(401);
		const fresh = await installationToken(h(), app, installationId);
		expect((await fetch(`${h().fakeUrl}/repos/${owner}/${inRepo}/issues/${number}`, { headers: { Authorization: `token ${fresh.token}` } })).status).toBe(200);
	}, 20_000);

	test('changing the selection sends installation_repositories', async () => {
		const app = await createAppOnFake(h(), uniqueName('sel'));
		const owner = uniqueName('acct');
		const { installationId } = await h().fakeGithub.installApp(app.id, { account: owner, repos: [`${owner}/a`] });
		await h().fakeGithub.installApp(app.id, { account: owner, repos: [`${owner}/a`, `${owner}/b`] });
		const log = (await h().fakeGithub.state()).appDeliveries!.filter((d) => d.appId === app.id);
		expect(log.map((d) => [d.event, d.action, d.installationId])).toEqual([
			['installation', 'created', installationId],
			['installation_repositories', 'added', installationId]
		]);
	});
});

describe('app webhooks and the delivery log', () => {
	test('repo events go to the app with installation; outage → status 0; attempts redeliver the same guid', async () => {
		const app = await createAppOnFake(h(), uniqueName('hook'));
		const owner = uniqueName('acct');
		const repo = uniqueName('r');
		const { installationId } = await h().fakeGithub.installApp(app.id, { account: owner, repos: [`${owner}/${repo}`] });

		await h().fakeGithub.webhookOutage(true);
		const { deliveryId } = await h().fakeGithub.createIssue({ owner, repo, author: 'mallory', title: 'during outage' });
		await h().fakeGithub.webhookOutage(false);
		expect((await h().fakeGithub.state()).webhookOutage).toBe(false);

		const list = (await (await asApp(h(), app, '/app/hook/deliveries?per_page=100')).json()) as {
			id: number;
			guid: string;
			event: string;
			action: string | null;
			status_code: number;
			redelivery: boolean;
			installation_id: number | null;
			repository_id: number | null;
		}[];
		const failed = list.find((d) => d.guid === deliveryId)!;
		expect(failed).toMatchObject({ event: 'issues', action: 'opened', status_code: 0, redelivery: false, installation_id: installationId });
		expect(failed.repository_id).toBeNumber();

		const attempt = await asApp(h(), app, `/app/hook/deliveries/${failed.id}/attempts`, { method: 'POST' });
		expect(attempt.status).toBe(202);
		await h().waitFor(async () => {
			const log = (await h().fakeGithub.state()).appDeliveries!.filter((d) => d.guid === deliveryId);
			return log.length === 2 && log[1]!.redelivery && log[1]!.statusCode !== 0;
		}, { message: 'redelivery logged with a response', timeout: 10_000 });

		// Paging: per_page=1 returns a Link to the next page.
		const page = await asApp(h(), app, '/app/hook/deliveries?per_page=1');
		expect(((await page.json()) as unknown[]).length).toBe(1);
		expect(page.headers.get('link')).toContain('rel="next"');
	}, 20_000);
});

describe('GitHub App user OAuth', () => {
	test("the app's client id/secret exchange codes for ghu_ tokens; /user works", async () => {
		const app = await createAppOnFake(h(), uniqueName('oauth'));
		const authorize = await fetch(
			`${h().fakeUrl}/login/oauth/authorize?client_id=${app.clientId}&redirect_uri=${encodeURIComponent(`${h().appUrl}/auth/callback`)}&state=st&login=admin`,
			{ redirect: 'manual' }
		);
		expect(authorize.status).toBe(302);
		const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!;
		const exchange = (secret: string) =>
			fetch(`${h().fakeUrl}/login/oauth/access_token`, {
				method: 'POST',
				headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
				body: JSON.stringify({ client_id: app.clientId, client_secret: secret, code })
			}).then((r) => r.json() as Promise<Record<string, string>>);
		expect((await exchange('wrong')).error).toBe('incorrect_client_credentials');
		const tok = await exchange(app.clientSecret);
		expect(tok.access_token).toStartWith('ghu_');
		const me = (await (await fetch(`${h().fakeUrl}/user`, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()) as { login: string };
		expect(me.login).toBe('admin');
	});
});
