/**
 * The admin section and the restructured app (ADR 0290, 0291), against the
 * running app in production mode (the default harness: no GRANARY_DEV,
 * FAKE_GITHUB_URL set, LOADGEN_URL and GRANARY_DEBUGGER unset).
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { runCli, useHarness } from './harness';
import { consumeLoginLink } from './github-app';
import { openIssue, waitClosedOnGithub } from './helpers';

const h = useHarness();
let cookie = '';

beforeAll(async () => {
	const link = await runCli(h(), ['login-link', 'admin', '--json']);
	if (link.code !== 0) throw new Error(`login-link: ${link.stderr || link.stdout}`);
	({ cookie } = await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url));
});

beforeEach(async () => {
	await h().fakeGithub.reset({ keepApps: true });
});

const asAdmin = (path: string) => h().fetchApp(path, { headers: { cookie } });

describe('moved pages', () => {
	test('old routes redirect permanently, keeping the query', async () => {
		const cases: [string, string][] = [
			['/__dev/traces', '/admin/traces'],
			['/__dev', '/admin'],
			['/actors', '/admin/actors'],
			['/actors/allowlist/main', '/admin/actors/allowlist/main'],
			['/ops/actors', '/admin/actors'],
			['/deliveries?state=ignored', '/activity?state=ignored'],
			['/effects', '/activity'],
			['/verdicts', '/activity'],
			['/allowlist', '/policy'],
			['/settings/closing-message', '/policy/closing-message']
		];
		for (const [from, to] of cases) {
			const res = await h().fetchApp(from);
			expect(res.status, from).toBe(308);
			expect(res.headers.get('location'), from).toBe(to);
		}
	});
});

describe('admin section in production mode', () => {
	test('signed-out visitors get the sign-in page, not the section', async () => {
		const html = await (await h().fetchApp('/admin')).text();
		expect(html).toContain('Sign in to granary');
		expect(html).not.toContain('data-testid="admin-status"');
	});

	test('admins see it; areas off here explain how to turn them on', async () => {
		const overview = await (await asAdmin('/admin')).text();
		expect(overview).toContain('data-testid="admin-sidebar"');
		expect(overview).toContain('data-testid="admin-status"');

		// Impersonation is development-only; LOADGEN_URL is unset.
		for (const path of ['/admin/sessions', '/admin/load', '/admin/load/personas']) {
			const html = await (await asAdmin(path)).text();
			expect(html, path).toContain('data-testid="admin-unavailable"');
		}
		// FAKE_GITHUB_URL is set explicitly, so the fake GitHub area is on.
		expect(await (await asAdmin('/admin/github')).text()).not.toContain('data-testid="admin-unavailable"');
		// The debugger is off without GRANARY_DEBUGGER=1 and says how to reach it.
		const dbg = await (await asAdmin('/admin/debugger')).text();
		expect(dbg).toContain('GRANARY_DEBUGGER=1');
		expect(dbg).toContain('ssh -L');
		// The actor list and inspector live here.
		expect(await (await asAdmin('/admin/actors')).text()).toContain('data-testid="ops-actor"');
	});

	test('the development JSON API does not exist in production mode', async () => {
		expect((await asAdmin('/admin/api/ops/status')).status).toBe(404);
	});
});

describe('activity', () => {
	test('a closed issue shows up as one activity row, and the item page links into /admin', async () => {
		const i = await openIssue(h(), 'mallory');
		await waitClosedOnGithub(h(), i);
		await h().waitFor(
			async () => {
				const html = await (await asAdmin('/activity?outcome=closed')).text();
				return html.includes(i.repo) ? html : undefined;
			},
			{ timeout: 15_000, message: 'closed issue listed in /activity' }
		);
		const item = await (await asAdmin(`/issues/${i.issueKey}`)).text();
		expect(item).toContain('Not on the allowlist');
		expect(item).toContain(`href="/admin/actors/issue/${i.issueKey}"`);
		expect(item).not.toContain('Live actor');
	});

	test('the main nav has no actor internals', async () => {
		const html = await (await asAdmin('/')).text();
		expect(html).not.toContain('data-testid="stat-actors"');
		expect(html).not.toContain('href="/actors"');
		expect(html).toContain('href="/activity"');
		expect(html).toContain('href="/policy"');
		expect(html).toContain('href="/admin"');
	});
});

describe('deliveries that are not about an item', () => {
	test('/admin/deliveries shows installation events by default and items only under "All"', async () => {
		await openIssue(h(), 'mallory');
		// Every delivery including the issue's, once the inbox has it.
		const all = await h().waitFor(
			async () => {
				const html = await (await asAdmin('/admin/deliveries?show=all')).text();
				return html.includes('data-event="issues"') ? html : null;
			},
			{ message: 'issues delivery listed under "All"', timeout: 20_000 }
		);
		expect(all).toContain('data-testid="delivery-row"');

		// Default view: only deliveries without an issue or pull request (the harness's app installation).
		const other = await (await asAdmin('/admin/deliveries')).text();
		expect(other).toMatch(/data-event="installation(_repositories)?"/);
		expect(other).not.toContain('data-event="issues"');
		expect(other).toContain('href="/admin/deliveries"'); // in the admin sidebar
	});

	test('signed-out visitors do not get the deliveries page', async () => {
		const html = await (await h().fetchApp('/admin/deliveries')).text();
		expect(html).not.toContain('data-testid="delivery-row"');
	});
});
