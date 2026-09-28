/**
 * Regression guard for user-facing copy (ADR 0292): production pages must not
 * carry development or host-specific instructions ("mise run", "fnox",
 * "exe.dev") or ADR numbers. Checks the rendered, visible text of every
 * signed-in page outside /admin (which may use technical terms).
 *
 * `exe.dev` is allowed where it names a real product option: the telemetry
 * sink form offers exe.dev authentication modes, and the secrets form offers
 * an "exe.dev VM token" kind.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { runCli, useHarness } from './harness';
import { consumeLoginLink } from './github-app';
import { openIssue, waitClosedOnGithub } from './helpers';

const h = useHarness();
let cookie = '';
let itemKey = '';

beforeAll(async () => {
	const link = await runCli(h(), ['login-link', 'admin', '--json']);
	if (link.code !== 0) throw new Error(`login-link: ${link.stderr || link.stdout}`);
	({ cookie } = await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url));
	const opened = await openIssue(h(), 'mallory', { title: 'copy guard' });
	await waitClosedOnGithub(h(), opened);
	itemKey = opened.issueKey;
});

/** Visible text: scripts, styles and tags removed, whitespace collapsed. */
function visibleText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z#0-9]+;/gi, ' ')
		.replace(/\s+/g, ' ');
}

const PAGES = [
	'/',
	'/activity',
	'/policy',
	'/policy/closing-message',
	'/ops',
	'/ops/conditions',
	'/ops/backups',
	'/ops/destinations',
	'/ops/destinations/new',
	'/ops/plans',
	'/ops/drills',
	'/ops/telemetry',
	'/ops/telemetry/new',
	'/ops/secrets',
	'/ops/settings',
	'/settings',
	'/settings/github',
	'/settings/admins',
	'/settings/login-links',
	'/settings/audit',
	'/does-not-exist'
];

const EXE_DEV_ALLOWED = (path: string) => path.startsWith('/ops/telemetry') || path === '/ops/secrets';

describe('production copy', () => {
	test('no dev tooling, host-specific instructions or ADR numbers on user-facing pages', async () => {
		const backups = await (await h().fetchApp('/ops/backups', { headers: { cookie } })).text();
		const run = /href="\/ops\/backups\/([^"]+)"/.exec(backups)?.[1];
		const paths = [...PAGES, `/issues/${itemKey}`, ...(run ? [`/ops/backups/${run}`] : [])];

		const problems: string[] = [];
		const seen: Record<string, string> = {};
		for (const path of paths) {
			const res = await h().fetchApp(path, { headers: { cookie } });
			const text = visibleText(await res.text());
			seen[path] = text;
			const rules: [string, RegExp][] = [
				['mise run', /mise run/i],
				['fnox', /\bfnox\b/i],
				['ADR number', /\bADR \d{3,4}/],
				...(EXE_DEV_ALLOWED(path) ? [] : ([['exe.dev', /exe\.dev/i]] as [string, RegExp][]))
			];
			for (const [name, re] of rules) {
				const m = re.exec(text);
				if (m) problems.push(`${path}: "${name}" in …${text.slice(Math.max(0, m.index - 60), m.index + 60)}…`);
			}
		}
		expect(problems).toEqual([]);
		// The pages really rendered signed in (not the sign-in page or an error).
		expect(seen['/ops/secrets']).toContain('Credentials for destinations and telemetry');
		expect(seen['/ops/drills']).toContain('Restore drills');
		expect(seen['/settings/audit']).toContain('Who changed admins');
		expect(seen['/']).not.toContain('Sign in to granary');
	});

	test('the item page shows readable labels, not codes', async () => {
		const text = visibleText(await (await h().fetchApp(`/issues/${itemKey}`, { headers: { cookie } })).text());
		expect(text).toContain('Not on the allowlist');
		expect(text).toContain('Issue opened');
		expect(text).not.toMatch(/\bnot-allowed\b/);
		expect(text).not.toMatch(/\bissues\.opened\b/);
		expect(text).not.toMatch(/close:\d+:\d+/);
	});
});
