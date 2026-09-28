/**
 * Crash durability (ADR 0003): the app is SIGKILLed mid-flight and
 * restarted against the same SQLite file; the issue is closed exactly once.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { useHarness, uniqueName } from './harness';
import { actorFinished, and, inEpoch, finalStates } from './traces';
import { OWNER, expectClosedOnce, fakeIssue, openIssue, waitClosedOnGithub } from './helpers';

const h = useHarness();

beforeEach(async () => {
	await h().fakeGithub.reset();
});

describe('crash durability', () => {
	test(
		'SIGKILL right after the webhook was accepted → closed exactly once after restart',
		async () => {
			const i = await openIssue(h(), 'mallory'); // resolves after the 202
			await h().restartApp({ kill: 'SIGKILL' });
			const issue = await waitClosedOnGithub(h(), i, 60_000);
			// Give a possible duplicate run time to show up.
			await Bun.sleep(1500);
			expectClosedOnce(await fakeIssue(h(), i), i);
			expect(issue.state_reason).toBe('not_planned');
			await h().waitForSpan(actorFinished(i.address, 'closed'), { timeout: 10_000 });
			expect(finalStates(h().index(), i.address).filter((s) => s === 'closed')).toHaveLength(1);
		},
		120_000
	);

	test(
		'SIGKILL after the comment was posted but before the issue was closed → no second comment',
		async () => {
			const repo = uniqueName();
			// Hold the relay between its two calls: the PATCH fails once with Retry-After.
			await h().fakeGithub.injectFault({
				method: 'PATCH',
				pathPattern: `^/repos/${OWNER}/${repo}/issues/\\d+$`,
				status: 503,
				count: 1,
				retryAfter: 5
			});
			const i = await openIssue(h(), 'mallory', { repo });
			await h().waitFor(
				async () => {
					const s = await h().fakeGithub.state();
					const fault = s.faults[0];
					const issue = s.issues.find((x) => x.repo === repo);
					return fault?.remaining === 0 && issue && issue.comments.length === 1;
				},
				{ timeout: 30_000, message: 'comment posted and PATCH fault consumed' }
			);
			const epochBefore = h().collector.epochOf('granary');
			await h().restartApp({ kill: 'SIGKILL' });
			await waitClosedOnGithub(h(), i, 60_000);
			await h().waitForSpan(and(actorFinished(i.address, 'closed'), inEpoch(epochBefore + 1)), { timeout: 30_000 });
			await Bun.sleep(1000);
			expectClosedOnce(await fakeIssue(h(), i), i);
		},
		120_000
	);
});
