/**
 * Let an author in from Activity (ADR 0313), against the running app and the
 * fake GitHub: the `admitAuthor` remote command allowlists the author of a
 * closed item for the chosen scope, lifts an active block, and the relay
 * reopens what granary closed on them there — nothing elsewhere.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { runCli, uniqueName, useHarness, type Harness } from './harness';
import { consumeLoginLink, remoteCommand } from './github-app';
import { expectClosedOnce, expectUntouched, fakeIssue, openIssue, settle, waitClosedOnGithub, type OpenedIssue } from './helpers';
import { actorFinished } from './traces';

const T = 60_000;
const h: () => Harness = useHarness();
let cookie = '';

interface AdmitResult {
	login: string;
	scope: string;
	added: boolean;
	unblocked: boolean;
	reopening: string[];
}

const admit = (issueKey: string, scope: 'repository' | 'owner' | 'everywhere') =>
	remoteCommand<AdmitResult>(h(), cookie, '/activity', 'admitAuthor', { issueKey, scope });

function waitReopened(i: OpenedIssue) {
	return h().waitFor(async () => {
		const issue = await fakeIssue(h(), i);
		return issue.state === 'open' ? issue : null;
	}, { message: `${i.repo}#${i.number} is reopened` });
}

async function closed(author: string, repo?: string): Promise<OpenedIssue> {
	const i = await openIssue(h(), author, repo ? { repo } : {});
	expectClosedOnce(await waitClosedOnGithub(h(), i), i);
	return i;
}

beforeAll(async () => {
	const link = await runCli(h(), ['login-link', 'admin', '--json']);
	cookie = (await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url)).cookie;
}, T);

describe('let them in from Activity', () => {
	test(
		'repository scope: what was closed there is reopened, elsewhere stays closed, their next issue there stays open',
		async () => {
			const repo = uniqueName();
			const first = await closed('oscar', repo);
			const second = await closed('oscar', repo);
			const elsewhere = await closed('oscar');

			const html = await (await h().fetchApp('/activity', { headers: { Cookie: cookie } })).text();
			expect(html).toContain('data-testid="admit-author"');

			const r = await admit(first.issueKey, 'repository');
			expect(r).toMatchObject({ login: 'oscar', scope: `acme/${repo}`.toLowerCase(), added: true, unblocked: false });
			expect(r.reopening.sort()).toEqual([`acme/${repo}#${first.number}`, `acme/${repo}#${second.number}`].sort());

			for (const i of [first, second]) {
				const issue = await waitReopened(i);
				expect(issue.state_reason).toBe('reopened');
				// Reopened, not commented on again.
				expect(issue.comments).toHaveLength(1);
			}
			await settle(500);
			expect((await fakeIssue(h(), elsewhere)).state).toBe('closed');

			const next = await openIssue(h(), 'oscar', { repo });
			await h().waitForSpan(actorFinished(next.address, 'allowed'));
			await settle(500);
			expectUntouched(await fakeIssue(h(), next));

			// Activity says why; asking again changes nothing.
			const after = await h().waitFor(async () => {
				const page = await (await h().fetchApp('/activity', { headers: { Cookie: cookie } })).text();
				return page.includes('Reopened: an admin let them in') ? page : null;
			}, { message: 'Activity shows the reopened items' });
			expect(after).toContain('Reopened: an admin let them in');
			expect(await admit(first.issueKey, 'repository')).toMatchObject({ added: false, unblocked: false, reopening: [] });
			const policy = await (await h().fetchApp('/policy', { headers: { Cookie: cookie } })).text();
			expect(policy).toContain(`acme/${repo}`.toLowerCase());
		},
		T
	);

	test(
		'a blocked author let in everywhere: the block is lifted and every closed item reopened',
		async () => {
			const login = `blk${uniqueName().slice(-6)}`;
			const block = await runCli(h(), ['blocklist', 'add', login, '--json']);
			expect(block.code).toBe(0);
			const a = await closed(login);
			const b = await closed(login);

			const r = await admit(a.issueKey, 'everywhere');
			expect(r).toMatchObject({ login, scope: '', added: true, unblocked: true });
			expect(r.reopening).toHaveLength(2);
			await waitReopened(a);
			await waitReopened(b);

			// No longer blocked: their next issue anywhere stays open.
			const next = await openIssue(h(), login);
			await h().waitForSpan(actorFinished(next.address, 'allowed'));
		},
		T
	);

	test(
		'an item granary did not close is refused',
		async () => {
			const allowed = await openIssue(h(), 'alice');
			await h().waitForSpan(actorFinished(allowed.address, 'allowed'));
			await expect(admit(allowed.issueKey, 'repository')).rejects.toThrow(/did not close this item/);
		},
		T
	);
});
