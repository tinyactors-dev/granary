/**
 * GitHub REST failures (ADR 0003 relay rules) driven by fake-GitHub fault
 * injection (ADR 0035).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { useHarness } from './harness';
import { actorFinished, finalStates } from './traces';
import { OWNER, expectClosedOnce, fakeIssue, openIssue, settle, waitClosedOnGithub } from './helpers';
import { uniqueName } from './harness';

const h = useHarness();

beforeEach(async () => {
	await h().fakeGithub.reset();
});

/** Pattern for one repo's issue-comment endpoint. */
const commentsPath = (repo: string) => `^/repos/${OWNER}/${repo}/issues/\\d+/comments$`;

describe('REST faults', () => {
	test(
		'500 on POST comments ×2 → retried, eventually closed with one comment',
		async () => {
			const repo = uniqueName();
			const { id } = await h().fakeGithub.injectFault({ method: 'POST', pathPattern: commentsPath(repo), status: 500, count: 2 });
			const i = await openIssue(h(), 'mallory', { repo });
			await h().waitForSpan(actorFinished(i.address, 'closed'), { timeout: 60_000 });
			expectClosedOnce(await waitClosedOnGithub(h(), i), i);
			const fault = (await h().fakeGithub.state()).faults.find((f) => f.id === id);
			expect(fault?.remaining).toBe(0);
		},
		90_000
	);

	test(
		'403 with Retry-After → waits at least Retry-After, then closes',
		async () => {
			const repo = uniqueName();
			const retryAfter = 3;
			await h().fakeGithub.injectFault({ method: 'POST', pathPattern: commentsPath(repo), status: 403, count: 1, retryAfter });
			const i = await openIssue(h(), 'mallory', { repo });
			await h().waitForSpan(actorFinished(i.address, 'closed'), { timeout: 60_000 });
			const issue = await waitClosedOnGithub(h(), i);
			expectClosedOnce(issue, i);
			const waited = Date.parse(issue.comments[0]!.created_at!) - Date.parse(issue.created_at!);
			expect(waited).toBeGreaterThanOrEqual(retryAfter * 1000 - 500);
		},
		90_000
	);

	test(
		'permanent failure → issue actor ends failed (gave up), issue stays open',
		async () => {
			const repo = uniqueName();
			await h().fakeGithub.injectFault({ method: 'POST', pathPattern: commentsPath(repo), status: 500, count: 1000 });
			const i = await openIssue(h(), 'mallory', { repo });
			await h().waitForSpan(actorFinished(i.address, 'failed'), { timeout: 170_000, message: `${i.address.name} failed` });
			await settle(500);
			const issue = await fakeIssue(h(), i);
			expect(issue.state).toBe('open');
			expect(issue.comments).toHaveLength(0);
			expect(finalStates(h().index(), i.address)).toEqual(['failed']);
			// The session took github.gave-up; the done reason says so (when the app attaches it).
			const session = h().index().sessionsAt(i.address)[0]!;
			expect(session.events).toContain('github.gave-up');
			expect(session.doneReason ?? 'github-gave-up').toStartWith('github-gave-up');
		},
		180_000
	);
});
