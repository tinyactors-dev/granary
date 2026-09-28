/**
 * granary with an in-product GitHub App (ADR 0160, 0161, 0164, 0203):
 * first run without any GitHub env, login-link bootstrap, manifest setup,
 * installation sync, closing via installation tokens, token refresh and
 * sign-in via the app's OAuth.
 *
 * The scenarios run in order and share one app.
 */
import { describe, expect, test } from 'bun:test';
import { runCli, useHarness, type Harness } from './harness';
import { consumeLoginLink, cookiesOf, remoteCommand, setupGitHubApp } from './github-app';
import { expectClosedOnce, expectUntouched, fakeIssue, openIssue, OWNER, settle, waitClosedOnGithub } from './helpers';
import { actorFinished } from './traces';

const TOKEN_TTL_MS = 4000;
const T = 60_000;


/** No GitHub env at all: granary must come up in `none` mode (ADR 0157, 0160). */
const h: () => Harness = useHarness({
	appEnv: {
		GITHUB_TOKEN: '',
		GITHUB_WEBHOOK_SECRET: '',
		GITHUB_OAUTH_CLIENT_ID: '',
		GITHUB_OAUTH_CLIENT_SECRET: '',
		GRANARY_MASTER_KEY: 'b1'.repeat(32)
	},
	fakeEnv: { FAKE_GITHUB_INSTALLATION_TOKEN_TTL_MS: String(TOKEN_TTL_MS) }
});


let cookie = '';
let app = { appId: 0, slug: '' };

describe('GitHub App (in-product)', () => {
	test(
		'before setup: webhooks are refused with 503 and admins are sent to /settings/github',
		async () => {
			const res = await h().postWebhook('{}', { signature: 'sha256=00' });
			expect(res.status).toBe(503);
			const link = await runCli(h(), ['login-link', 'admin', '--json']);
			expect(link.code).toBe(0);
			const { url } = JSON.parse(link.stdout) as { url: string };
			expect(url).toStartWith(`${h().appUrl}/auth/link/`);
			const session = await consumeLoginLink(h(), url);
			expect(session.location).toContain('/settings/github');
			cookie = session.cookie;
			// Single use.
			const again = await h().fetchApp(new URL(url).pathname, { method: 'POST', headers: { Origin: h().appUrl } });
			expect(cookiesOf(again)).not.toContain('granary_session=');
		},
		T
	);

	test(
		'manifest flow: one click creates the app; granary stores its credentials',
		async () => {
			const created = await setupGitHubApp(h(), cookie);
			app = { appId: created.appId, slug: created.slug };
			expect(created.callbackStatus).toBeGreaterThanOrEqual(300);
			expect(created.callbackStatus).toBeLessThan(400);
			const status = await runCli(h(), ['github', 'status', '--json']);
			expect(status.code).toBe(0);
			expect(JSON.parse(status.stdout)).toMatchObject({ mode: 'app', app: { slug: app.slug } });
		},
		T
	);

	test(
		'installation sync: the installation webhook makes the repos known',
		async () => {
			await h().fakeGithub.installApp(app.appId, { account: OWNER });
			await h().waitFor(
				async () => {
					const s = JSON.parse((await runCli(h(), ['github', 'status', '--json'])).stdout) as { installations?: { account: string }[] };
					return s.installations?.some((i) => i.account === OWNER);
				},
				{ message: 'installation synced', timeout: 20_000 }
			);
		},
		T
	);

	test(
		'relay closes an issue with an installation token (comment by <slug>[bot])',
		async () => {
			const i = await openIssue(h(), 'mallory');
			await h().waitForSpan(actorFinished(i.address, 'closed'), { message: `${i.address.name} closed` });
			const issue = await waitClosedOnGithub(h(), i);
			expectClosedOnce(issue, i);
			expect(issue.comments[0]!.user.login).toBe(`${app.slug}[bot]`);
		},
		T
	);

	test(
		'installation tokens are refreshed when they expire',
		async () => {
			await settle(TOKEN_TTL_MS + 500);
			const i = await openIssue(h(), 'mallory');
			const issue = await waitClosedOnGithub(h(), i);
			expectClosedOnce(issue, i);
		},
		T
	);

	test(
		'allowlisted users stay open in app mode too',
		async () => {
			const i = await openIssue(h(), 'alice');
			await h().waitForSpan(actorFinished(i.address, 'allowed'));
			expect((await fakeIssue(h(), i)).state).toBe('open');
		},
		T
	);

	test(
		"sign-in uses the app's OAuth client",
		async () => {
			const start = await h().fetchApp('/auth/login?redirect=/');
			expect(start.status).toBe(302);
			const authorize = new URL(start.headers.get('location')!);
			const fakeApp = (await h().fakeGithub.state()).apps!.find((a) => a.id === app.appId)!;
			expect(authorize.searchParams.get('client_id')).toBe(fakeApp.clientId);
			authorize.searchParams.set('login', 'admin');
			const back = await fetch(authorize, { redirect: 'manual' });
			const cb = new URL(back.headers.get('location')!);
			const done = await h().fetchApp(`${cb.pathname}${cb.search}`, { headers: { Cookie: cookiesOf(start) } });
			expect(cookiesOf(done)).toContain('granary_session=');
		},
		T
	);

	test(
		'per-repo disable: issues in a disabled repo are left alone; re-enabling guards it again',
		async () => {
			const first = await openIssue(h(), 'mallory');
			await waitClosedOnGithub(h(), first);
			await remoteCommand(h(), cookie, '/settings/github', 'setRepoEnabled', { repoId: first.repoId, enabled: false });
			const ignored = await openIssue(h(), 'mallory', { repo: first.repo });
			await settle(2000);
			expectUntouched(await fakeIssue(h(), ignored));
			await remoteCommand(h(), cookie, '/settings/github', 'setRepoEnabled', { repoId: first.repoId, enabled: true });
			const guarded = await openIssue(h(), 'mallory', { repo: first.repo });
			expectClosedOnce(await waitClosedOnGithub(h(), guarded), guarded);
		},
		T
	);
});
