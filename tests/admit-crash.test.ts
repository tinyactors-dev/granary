/**
 * Letting an author in survives process restarts (ADR 0313, ADR 0003): the
 * app is SIGKILLed at each point between the admin's click and GitHub's
 * reopened item, restarted against the same SQLite file, and every item is
 * reopened exactly once, recorded as allowed, with the allowlist entry and
 * the lifted block still in force. Also: a deleted item is given up at once.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { runCli, uniqueName, useHarness, type Harness } from './harness';
import { consumeLoginLink, remoteCommand } from './github-app';
import { OWNER, expectClosedOnce, expectUntouched, fakeIssue, openIssue, settle, waitClosedOnGithub, type OpenedIssue } from './helpers';
import { actorFinished } from './traces';

const T = 120_000;
const h: () => Harness = useHarness();
let cookie = '';

const admit = (issueKey: string, scope: 'repository' | 'owner' | 'everywhere') =>
	remoteCommand<{ login: string; scope: string; added: boolean; unblocked: boolean; reopening: string[] }>(h(), cookie, '/activity', 'admitAuthor', { issueKey, scope });

async function closed(author: string, repo: string): Promise<OpenedIssue> {
	const i = await openIssue(h(), author, { repo });
	expectClosedOnce(await waitClosedOnGithub(h(), i), i);
	await h().waitForSpan(actorFinished(i.address, 'closed'));
	return i;
}

/** The reopen action's state on the item page (`done`, `dead`, …), or null when there is none. */
async function reopenState(i: OpenedIssue): Promise<{ state: string; html: string } | null> {
	const html = await (await h().fetchApp(`/issues/${i.issueKey}`, { headers: { Cookie: cookie } })).text();
	const at = html.indexOf('data-testid="reopen-card"');
	if (at < 0) return null;
	const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at));
	return { state: /data-state="([a-z]+)"/.exec(tag)?.[1] ?? '?', html };
}

function waitReopenState(i: OpenedIssue, state: string, timeout = 60_000) {
	return h().waitFor(async () => {
		const r = await reopenState(i);
		return r?.state === state ? r : null;
	}, { timeout, message: `${i.repo}#${i.number}: reopen action ${state}` });
}

/** `issue.reopened` events for the item in the fake's log. */
async function reopenedEvents(i: OpenedIssue) {
	const { events } = await h().fakeGithub.eventsLog();
	return events.filter((e): e is Extract<typeof e, { type: 'issue.reopened' | 'issue.deleted' }> => e.type === 'issue.reopened' && e.repo === i.repo && e.number === i.number);
}

async function expectAdmitted(i: OpenedIssue) {
	await waitReopenState(i, 'done');
	const issue = await fakeIssue(h(), i);
	expect(issue.state).toBe('open');
	expect(issue.state_reason).toBe('reopened');
	// Reopened once, by the app, and told once: the closing comment, then exactly one let-in comment.
	const reopened = await reopenedEvents(i);
	expect(reopened).toHaveLength(1);
	expect(reopened[0]!.by).toEndWith('[bot]');
	expect(issue.comments).toHaveLength(2);
	expect(issue.comments.filter((c) => (c.body ?? '').includes(`<!-- granary:reopen:${i.repoId}:${i.number} -->`))).toHaveLength(1);
	expect(issue.comments[1]!.body).toContain("you've been added to the allowlist");
	const page = (await reopenState(i))!.html;
	expect(page).toContain('Reopened: an admin let them in');
}

beforeAll(async () => {
	const link = await runCli(h(), ['login-link', 'admin', '--json']);
	cookie = (await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url)).cookie;
}, T);

describe('letting an author in survives restarts', () => {
	test(
		'SIGKILL after the admin let them in, before GitHub was asked → reopened once after restart; allowlist and lifted block kept',
		async () => {
			const repo = uniqueName();
			const login = `k${uniqueName().slice(-8)}`;
			expect((await runCli(h(), ['blocklist', 'add', login, '--json'])).code).toBe(0);
			const i = await closed(login, repo);
			// Hold the relay: GitHub refuses the reopen once, asking to come back in 5 s.
			await h().fakeGithub.injectFault({ method: 'PATCH', pathPattern: `^/repos/${OWNER}/${repo}/issues/${i.number}$`, status: 503, count: 1, retryAfter: 5 });

			const r = await admit(i.issueKey, 'repository');
			expect(r).toMatchObject({ login, added: true, unblocked: true, reopening: [`${OWNER}/${repo}#${i.number}`] });
			await h().waitFor(async () => (await h().fakeGithub.state()).faults.some((f) => f.pathPattern.includes(repo) && f.remaining === 0), { message: 'the relay tried once' });
			expect((await fakeIssue(h(), i)).state).toBe('closed');

			await h().restartApp({ kill: 'SIGKILL' });
			// The row is on disk, pending: the restarted relay honours Retry-After and reopens it.
			await expectAdmitted(i);

			// What the admin decided is still in force after the restart.
			const next = await openIssue(h(), login, { repo });
			await h().waitForSpan(actorFinished(next.address, 'allowed'));
			await settle(500);
			expectUntouched(await fakeIssue(h(), next));
		},
		T
	);

	test(
		'SIGKILL after GitHub reopened it but before granary recorded it → no second reopen, recorded after restart',
		async () => {
			const repo = uniqueName();
			const i = await closed('lostresponse', repo);
			// GitHub reopens the item, but its answer is lost (502); the relay retries in 5 s.
			await h().fakeGithub.injectFault({ method: 'PATCH', pathPattern: `^/repos/${OWNER}/${repo}/issues/${i.number}$`, status: 502, count: 1, retryAfter: 5, applied: true });

			await admit(i.issueKey, 'repository');
			await h().waitFor(async () => ((await fakeIssue(h(), i)).state === 'open' ? true : null), { message: 'GitHub reopened it' });
			await h().waitFor(async () => (await h().fakeGithub.state()).faults.some((f) => f.pathPattern.includes(repo) && f.remaining === 0), { message: 'the lost response was answered' });
			expect((await reopenState(i))?.state).not.toBe('done');

			await h().restartApp({ kill: 'SIGKILL' });
			await expectAdmitted(i);
		},
		T
	);

	test(
		'SIGKILL with one of two items reopened → the other is reopened after restart, the first not again',
		async () => {
			const repo = uniqueName();
			const first = await closed('halfway', repo);
			const second = await closed('halfway', repo);
			await h().fakeGithub.injectFault({ method: 'PATCH', pathPattern: `^/repos/${OWNER}/${repo}/issues/${second.number}$`, status: 503, count: 1, retryAfter: 5 });

			const r = await admit(first.issueKey, 'owner');
			expect(r.reopening).toEqual(expect.arrayContaining([`${OWNER}/${repo}#${first.number}`, `${OWNER}/${repo}#${second.number}`]));
			await waitReopenState(first, 'done');
			await h().waitFor(async () => (await h().fakeGithub.state()).faults.some((f) => f.pathPattern.includes(repo) && f.remaining === 0), { message: 'the second was refused once' });
			expect((await fakeIssue(h(), second)).state).toBe('closed');

			await h().restartApp({ kill: 'SIGKILL' });
			await expectAdmitted(second);
			await settle(500);
			await expectAdmitted(first);
		},
		T
	);

	test(
		'SIGKILL after the comment was posted but its response lost → no second comment after restart',
		async () => {
			const repo = uniqueName();
			const i = await closed('lostcomment', repo);
			// The reopen goes through; the comment is posted, but GitHub's answer is lost (502), retry in 5 s.
			await h().fakeGithub.injectFault({ method: 'POST', pathPattern: `^/repos/${OWNER}/${repo}/issues/${i.number}/comments$`, status: 502, count: 1, retryAfter: 5, applied: true });

			await admit(i.issueKey, 'repository');
			await h().waitFor(async () => ((await fakeIssue(h(), i)).comments.length === 2 ? true : null), { message: 'the let-in comment is on GitHub' });
			await h().waitFor(async () => (await h().fakeGithub.state()).faults.some((f) => f.pathPattern.includes(repo) && f.remaining === 0), { message: 'the lost response was answered' });
			expect((await reopenState(i))?.state).not.toBe('done');

			await h().restartApp({ kill: 'SIGKILL' });
			// The retry finds the marker instead of posting again.
			await expectAdmitted(i);
		},
		T
	);

	test(
		'SIGKILL after the reopen, with the comment refused once → reopened once and told once after restart',
		async () => {
			const repo = uniqueName();
			const i = await closed('refusedcomment', repo);
			await h().fakeGithub.injectFault({ method: 'POST', pathPattern: `^/repos/${OWNER}/${repo}/issues/${i.number}/comments$`, status: 503, count: 1, retryAfter: 5 });

			await admit(i.issueKey, 'repository');
			await h().waitFor(async () => ((await fakeIssue(h(), i)).state === 'open' ? true : null), { message: 'reopened on GitHub' });
			await h().waitFor(async () => (await h().fakeGithub.state()).faults.some((f) => f.pathPattern.includes(repo) && f.remaining === 0), { message: 'the comment was refused once' });
			expect((await fakeIssue(h(), i)).comments).toHaveLength(1);

			await h().restartApp({ kill: 'SIGKILL' });
			await expectAdmitted(i);
		},
		T
	);

	test(
		'an item deleted on GitHub is given up at once (410); the rest are reopened',
		async () => {
			const repo = uniqueName();
			const kept = await closed('deleter', repo);
			const deleted = await closed('deleter', repo);
			await h().fakeGithub.deleteIssue({ owner: OWNER, repo, number: deleted.number, actor: OWNER });

			await admit(kept.issueKey, 'repository');
			await expectAdmitted(kept);
			const gone = await waitReopenState(deleted, 'dead', 15_000);
			expect(gone.html).toContain('deleted on GitHub (410)');
			// Not retried: one attempt.
			expect(gone.html).toMatch(/Attempts<\/dt>\s*<dd[^>]*>1<\/dd>/);
		},
		T
	);
});
