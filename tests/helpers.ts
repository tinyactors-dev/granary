/** Scenario helpers shared by the test files (ADR 0063). */
import { expect } from 'bun:test';
import type { AuthorAssociation } from '../src/lib/schemas/github';
import type { FakeIssue } from '../fake-github/schemas';
import { uniqueName, type Harness } from './harness';
import { issueAddress, type ActorAddress } from './traces';

export const OWNER = 'acme';

export interface OpenedIssue {
	owner: string;
	repo: string;
	repoId: number;
	number: number;
	deliveryId: string;
	address: ActorAddress;
	issueKey: string;
	effectKey: string;
	marker: string;
}

/** Ensure a fresh repo, open an issue as `author` and check the app accepted the webhook. */
export async function openIssue(
	h: Harness,
	author: string,
	options: { association?: AuthorAssociation; repo?: string; expectAccepted?: boolean; title?: string } = {}
): Promise<OpenedIssue> {
	const repo = options.repo ?? uniqueName();
	const { id: repoId } = await h.fakeGithub.ensureRepo({ owner: OWNER, name: repo });
	const { number, deliveryId } = await h.fakeGithub.createIssue({
		owner: OWNER,
		repo,
		author,
		title: options.title ?? `Issue by ${author}`,
		association: options.association
	});
	if (!deliveryId) throw new Error(`no GitHub App covers ${OWNER}/${repo} on the fake: nothing was delivered`);
	if (options.expectAccepted !== false) {
		const d = await h.fakeGithub.delivery(deliveryId);
		expect(d?.status).toBe('delivered');
		expect(d?.responseCode).toBe(202);
	}
	const effectKey = `close:${repoId}:${number}`;
	return {
		owner: OWNER,
		repo,
		repoId,
		number,
		deliveryId,
		address: issueAddress(repoId, number),
		issueKey: `${repoId}-${number}`,
		effectKey,
		marker: `<!-- granary:${effectKey} -->`
	};
}

export async function fakeIssue(h: Harness, i: OpenedIssue): Promise<FakeIssue> {
	const issue = await h.fakeGithub.issue(i.owner, i.repo, i.number);
	if (!issue) throw new Error(`issue ${i.owner}/${i.repo}#${i.number} missing from fake GitHub`);
	return issue;
}

/** Wait until the fake GitHub shows the issue closed. */
export function waitClosedOnGithub(h: Harness, i: OpenedIssue, timeout = 30_000) {
	return h.waitFor(
		async () => {
			const issue = await fakeIssue(h, i);
			return issue.state === 'closed' ? issue : undefined;
		},
		{ timeout, message: `${i.owner}/${i.repo}#${i.number} closed on fake GitHub` }
	);
}

/** The closed-by-granary end state: closed/not_planned, exactly one comment carrying the marker. */
export function expectClosedOnce(issue: FakeIssue, i: OpenedIssue) {
	expect(issue.state).toBe('closed');
	expect(issue.state_reason).toBe('not_planned');
	expect(issue.comments).toHaveLength(1);
	expect(issue.comments[0]!.body).toContain(i.marker);
}

/** Untouched: open, no comments. */
export function expectUntouched(issue: FakeIssue) {
	expect(issue.state).toBe('open');
	expect(issue.comments).toHaveLength(0);
}

/** Give the system time to (not) act, for negative assertions. */
export const settle = (ms = 1500) => Bun.sleep(ms);
