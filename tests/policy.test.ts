/**
 * Policy scenarios (ADR 0004): who may open issues. Assert through the
 * app's traces (issue actor final state) and the fake GitHub's state.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { signBody, useHarness } from './harness';
import { actorFinished, eventDelivered, finalStates, mentions } from './traces';
import { expectClosedOnce, expectUntouched, fakeIssue, openIssue, settle, waitClosedOnGithub } from './helpers';

const h = useHarness();
const T = 60_000;

beforeEach(async () => {
	await h().fakeGithub.reset();
});

describe('policy', () => {
	test(
		'allowlisted user (alice) → allowed, issue stays open, no comment',
		async () => {
			const i = await openIssue(h(), 'alice');
			await h().waitForSpan(actorFinished(i.address, 'allowed'), { message: `${i.address.name} allowed` });
			await settle(500);
			expectUntouched(await fakeIssue(h(), i));
			expect(finalStates(h().index(), i.address)).toEqual(['allowed']);
		},
		T
	);

	test(
		'allowlist match is case-insensitive (ALICE)',
		async () => {
			const i = await openIssue(h(), 'ALICE');
			await h().waitForSpan(actorFinished(i.address, 'allowed'));
			expectUntouched(await fakeIssue(h(), i));
		},
		T
	);

	test(
		'unknown user → closed as not_planned with exactly one marked comment',
		async () => {
			const i = await openIssue(h(), 'mallory');
			await h().waitForSpan(actorFinished(i.address, 'closed'), { message: `${i.address.name} closed` });
			expectClosedOnce(await fakeIssue(h(), i), i);
			expect(finalStates(h().index(), i.address)).toEqual(['closed']);
			// The actor went through the documented path.
			const session = h().index().sessionsAt(i.address)[0]!;
			expect(session.entered).toEqual(expect.arrayContaining(['checking', 'closing', 'closed']));
			expect(session.events).toEqual(expect.arrayContaining(['issue.opened', 'allowlist.verdict', 'github.closed']));
		},
		T
	);

	test(
		'unknown bot user is treated like any other user → closed',
		async () => {
			await h().fakeGithub.ensureUser({ login: 'helper-bot', type: 'Bot' });
			const i = await openIssue(h(), 'helper-bot');
			await h().waitForSpan(actorFinished(i.address, 'closed'));
			expectClosedOnce(await waitClosedOnGithub(h(), i), i);
		},
		T
	);

	for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR'] as const) {
		test(
			`author_association ${association} → allowed`,
			async () => {
				const i = await openIssue(h(), `maint-${association.toLowerCase()}`, { association });
				await h().waitForSpan(actorFinished(i.address, 'allowed'));
				await settle(500);
				expectUntouched(await fakeIssue(h(), i));
			},
			T
		);
	}

	test(
		'CONTRIBUTOR association is not enough → closed',
		async () => {
			const i = await openIssue(h(), 'drive-by', { association: 'CONTRIBUTOR' });
			await h().waitForSpan(actorFinished(i.address, 'closed'));
			expectClosedOnce(await waitClosedOnGithub(h(), i), i);
		},
		T
	);

	test(
		'duplicate delivery (redeliver the same id) → still exactly one comment',
		async () => {
			const i = await openIssue(h(), 'mallory');
			// Redeliver while the first run may still be closing …
			const early = await h().fakeGithub.redeliver(i.deliveryId);
			expect(early.responseCode).toBeGreaterThanOrEqual(200);
			expect(early.responseCode).toBeLessThan(300);
			await h().waitForSpan(actorFinished(i.address, 'closed'));
			// … and again after it finished.
			const late = await h().fakeGithub.redeliver(i.deliveryId);
			expect(late.responseCode).toBeGreaterThanOrEqual(200);
			expect(late.responseCode).toBeLessThan(300);
			await settle();
			expectClosedOnce(await fakeIssue(h(), i), i);
			expect(finalStates(h().index(), i.address).filter((s) => s === 'closed')).toHaveLength(1);
			expect((await h().fakeGithub.delivery(i.deliveryId))?.attempts).toBe(3);
		},
		T
	);

	test(
		'reopened issue → ignored, stays open',
		async () => {
			const i = await openIssue(h(), 'mallory');
			await h().waitForSpan(actorFinished(i.address, 'closed'));
			await waitClosedOnGithub(h(), i);
			const { deliveryId } = await h().fakeGithub.reopen({ owner: i.owner, repo: i.repo, number: i.number, actor: 'acme' });
			const d = await h().fakeGithub.delivery(deliveryId);
			expect(d?.status).toBe('delivered');
			await settle();
			const issue = await fakeIssue(h(), i);
			expect(issue.state).toBe('open');
			expect(issue.state_reason).toBe('reopened');
			expect(issue.comments).toHaveLength(1);
			// Only the original delivery reached an issue actor.
			expect(h().spansMatching(eventDelivered(i.address, 'issue.opened')).length).toBe(1);
			expect(finalStates(h().index(), i.address)).toEqual(['closed']);
		},
		T
	);

	test(
		'invalid or missing signature → 401 and no actor activity',
		async () => {
			const repoId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
			const issueKey = `${repoId}-1`;
			const payload = JSON.stringify({
				action: 'opened',
				issue: {
					id: repoId + 1,
					number: 1,
					title: 'forged',
					body: '',
					state: 'open',
					state_reason: null,
					user: { login: 'mallory', id: 1, type: 'User' },
					author_association: 'NONE',
					html_url: `https://github.com/acme/forged/issues/1`
				},
				repository: { id: repoId, name: 'forged', full_name: 'acme/forged', owner: { login: 'acme', id: 2 } },
				sender: { login: 'mallory', id: 1, type: 'User' }
			});
			const bad = await h().postWebhook(payload, { signature: 'sha256=' + '0'.repeat(64) });
			expect(bad.status).toBe(401);
			const missing = await h().postWebhook(payload);
			expect(missing.status).toBe(401);
			const wrongSecret = await h().postWebhook(payload, { signature: signBody(payload, 'not-the-secret') });
			expect(wrongSecret.status).toBe(401);
			await settle();
			expect(h().spansMatching(mentions(issueKey))).toHaveLength(0);
			expect(h().spansMatching(mentions(`"repoId":${repoId}`))).toHaveLength(0);
		},
		T
	);
});
