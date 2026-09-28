/**
 * Mobile layout guard (ADR 0295, 0296), against the running app. A bun test
 * cannot measure layout, so this checks the markup the responsive patterns
 * rely on, on every main route as rendered for an admin:
 *   - every shadcn table opts into the stacked phone layout (`stack` →
 *     `data-stack-table`), so no new table silently hides columns on phones;
 *   - the navigation is the drawer (menu button), not a second horizontally
 *     scrolling bar;
 *   - sub-navs carry the edge-fade affordance.
 * Visual verification at 390/768/1440px is manual with agent-browser (see ADR 0295).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { runCli, useHarness } from './harness';
import { consumeLoginLink } from './github-app';
import { openIssue } from './helpers';

const h = useHarness();
let cookie = '';
let itemPath = '';

beforeAll(async () => {
	const link = await runCli(h(), ['login-link', 'admin', '--json']);
	if (link.code !== 0) throw new Error(`login-link: ${link.stderr || link.stdout}`);
	({ cookie } = await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url));
	const issue = await openIssue(h(), 'mallory', { title: 'responsive guard' });
	itemPath = `/issues/${issue.issueKey}`;
});

const ROUTES = [
	'/',
	'/activity',
	'/policy',
	'/policy/closing-message',
	'/ops',
	'/ops/backups',
	'/ops/drills',
	'/ops/plans',
	'/ops/secrets',
	'/settings',
	'/settings/github',
	'/settings/admins',
	'/settings/login-links',
	'/settings/audit',
	'/admin',
	'/admin/actors',
	'/admin/traces',
	'/admin/github',
	'/admin/infra'
];

async function page(path: string): Promise<string> {
	const res = await h().fetchApp(path, { headers: { cookie } });
	expect(res.status, path).toBe(200);
	return res.text();
}

describe('responsive markup', () => {
	test('every table on every main route opts into the stacked phone layout', async () => {
		for (const path of [...ROUTES, itemPath]) {
			const html = await page(path);
			const containers = html.match(/<div[^>]*data-slot="table-container"[^>]*>/g) ?? [];
			for (const tag of containers) expect(tag, `${path}: ${tag}`).toContain('data-stack-table');
		}
	});

	test('navigation is a drawer, not a second scrolling bar; sub-navs fade', async () => {
		for (const path of ['/', '/ops/backups', '/admin/traces']) {
			const html = await page(path);
			expect(html, path).toContain('data-testid="mobile-nav-trigger"');
			expect(html, path).not.toContain('aria-label="Main (mobile)"');
		}
		expect(await page('/ops/backups')).toContain('scroll-fade-x');
	});
});
