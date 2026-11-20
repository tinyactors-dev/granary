/**
 * Introductions through GitHub Discussions (ADR 0310, 0311), against the
 * running app and the fake GitHub: the setup check, the link in closing
 * comments, recording introductions from `discussion` webhooks, approving
 * (scoped allowlist, reopened items, the reply on the discussion), declining,
 * withdrawing, and org-level introductions.
 *
 * The scenarios run in order and share the harness' app and an admin session.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { runCli, uniqueName, useHarness, type Harness } from './harness';
import { consumeLoginLink, remoteCommand } from './github-app';
import { expectClosedOnce, expectUntouched, fakeIssue, openIssue, OWNER, settle, waitClosedOnGithub } from './helpers';
import { actorFinished, type ActorAddress } from './traces';

const T = 60_000;
const h: () => Harness = useHarness();
let cookie = '';

const introAddress = (repoId: number, number: number): ActorAddress => ({ family: 'introduction', name: `${repoId}-${number}` });

interface SetupJson {
	entries: { owner: string; repo: string; org: boolean; state: string; newUrl: string | null }[];
}

/** Turn Discussions on and add the Introductions category, as an admin would on GitHub. */
async function setUpDiscussions(repo: string) {
	await h().fakeGithub.setDiscussionsEnabled(OWNER, repo, true);
	await h().fakeGithub.createCategory({ owner: OWNER, repo, name: 'Introductions', emoji: ':wave:' });
	await h().fakeGithub.createCategory({ owner: OWNER, repo, name: 'General' });
}

async function checkSetup(): Promise<SetupJson> {
	return remoteCommand<SetupJson>(h(), cookie, '/introductions', 'checkIntroductionSetup', undefined);
}

async function introduce(repo: string, author: string, category = 'introductions') {
	const { id: repoId } = await h().fakeGithub.ensureRepo({ owner: OWNER, name: repo });
	const d = await h().fakeGithub.createDiscussion({ owner: OWNER, repo, author, category, title: `Hi, I am ${author}`, body: `I would like to help with ${repo}.` });
	expect(d.deliveryId).not.toBeNull();
	const delivery = await h().fakeGithub.delivery(d.deliveryId!);
	expect(delivery?.responseCode).toBe(202);
	return { repoId, number: d.number, introKey: `${repoId}-${d.number}` };
}

async function introductionsPage(query = ''): Promise<string> {
	return (await h().fetchApp(`/introductions${query}`, { headers: { Cookie: cookie } })).text();
}

beforeAll(async () => {
	const link = await runCli(h(), ['login-link', 'admin', '--json']);
	cookie = (await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url)).cookie;
}, T);

describe('introductions', () => {
	test(
		'setup: a gated repository without Discussions is reported; once the category exists it is ready and closing comments link to it',
		async () => {
			const first = await openIssue(h(), 'mallory');
			expectClosedOnce(await waitClosedOnGithub(h(), first), first);
			let s = await checkSetup();
			expect(s.entries.find((e) => e.repo === first.repo)?.state).toBe('disabled');
			// The org discussions repository (`acme/.github`) is listed too, not found on the fake.
			expect(s.entries.find((e) => e.repo === '.github')).toMatchObject({ org: true, state: 'missing' });

			await h().fakeGithub.setDiscussionsEnabled(OWNER, first.repo, true);
			expect((await checkSetup()).entries.find((e) => e.repo === first.repo)?.state).toBe('no-category');

			await setUpDiscussions(first.repo);
			s = await checkSetup();
			const ready = s.entries.find((e) => e.repo === first.repo)!;
			expect(ready.state).toBe('ready');
			expect(ready.newUrl).toContain(`/${OWNER}/${first.repo}/discussions/new?category=introductions`);

			const second = await openIssue(h(), 'mallory', { repo: first.repo });
			const closed = await waitClosedOnGithub(h(), second);
			expectClosedOnce(closed, second);
			expect(closed.comments[0]!.body).toContain(ready.newUrl!);
			expect(closed.comments[0]!.body).toContain('Introduce yourself');
			// The first issue, closed before, says nothing about introductions.
			expect((await fakeIssue(h(), first)).comments[0]!.body).not.toContain('Introduce yourself');
		},
		T
	);

	test(
		'approve: allowlisted for that repository only, what was closed on them reopened, and told so on the discussion',
		async () => {
			const repo = uniqueName();
			const closedIssue = await openIssue(h(), 'trudy', { repo });
			await h().waitForSpan(actorFinished(closedIssue.address, 'closed'), { message: 'the first issue is closed' });
			await setUpDiscussions(repo);
			await checkSetup();

			const intro = await introduce(repo, 'trudy');
			const html = await h().waitFor(async () => {
				const page = await introductionsPage();
				return page.includes(`data-intro-key="${intro.introKey}"`) ? page : null;
			}, { message: 'the introduction is listed' });
			expect(html).toContain('I would like to help with');

			await remoteCommand(h(), cookie, '/introductions', 'approveIntroduction', { introKey: intro.introKey });
			await h().waitForSpan(actorFinished(introAddress(intro.repoId, intro.number), 'approved'), { message: 'introduction approved' });

			// Reopened on GitHub, its decision now "allowed".
			const reopened = await h().waitFor(async () => {
				const i = await fakeIssue(h(), closedIssue);
				return i.state === 'open' ? i : null;
			}, { message: 'the closed issue is reopened' });
			expect(reopened.state_reason).toBe('reopened');

			// One reply on the discussion, from the app, with the marker.
			const discussion = (await h().fakeGithub.discussion(OWNER, repo, intro.number))!;
			expect(discussion.comments).toHaveLength(1);
			expect(discussion.comments[0]!.author).toEndWith('[bot]');
			expect(discussion.comments[0]!.body).toContain("You're approved");
			expect(discussion.comments[0]!.body).toContain(`#${closedIssue.number}`);
			expect(discussion.comments[0]!.body).toContain(`<!-- granary:approve:${intro.repoId}:${intro.number} -->`);

			// Their next issue in that repository stays open…
			const allowed = await openIssue(h(), 'trudy', { repo });
			await h().waitForSpan(actorFinished(allowed.address, 'allowed'));
			await settle(500);
			expectUntouched(await fakeIssue(h(), allowed));
			// …one in another repository is closed.
			const elsewhere = await openIssue(h(), 'trudy');
			expectClosedOnce(await waitClosedOnGithub(h(), elsewhere), elsewhere);

			const page = await introductionsPage('?state=approved');
			expect(page).toContain(`data-intro-key="${intro.introKey}"`);
			const policy = await (await h().fetchApp('/policy', { headers: { Cookie: cookie } })).text();
			expect(policy).toContain(`${OWNER}/${repo}`.toLowerCase());
		},
		T
	);

	test(
		'decline: recorded in granary, nothing posted; a second approval of a decided introduction is refused',
		async () => {
			const repo = uniqueName();
			await openIssue(h(), 'eve', { repo });
			await setUpDiscussions(repo);
			const intro = await introduce(repo, 'eve');
			await h().waitFor(async () => ((await introductionsPage()).includes(`data-intro-key="${intro.introKey}"`) ? true : null));
			await remoteCommand(h(), cookie, '/introductions', 'declineIntroduction', { introKey: intro.introKey, note: 'spam' });
			await h().waitForSpan(actorFinished(introAddress(intro.repoId, intro.number), 'declined'));
			await settle(500);
			expect((await h().fakeGithub.discussion(OWNER, repo, intro.number))!.comments).toHaveLength(0);
			expect(await introductionsPage('?state=declined')).toContain(`data-intro-key="${intro.introKey}"`);
			await expect(remoteCommand(h(), cookie, '/introductions', 'approveIntroduction', { introKey: intro.introKey })).rejects.toThrow(/declined/);
		},
		T
	);

	test(
		'other categories are not introductions; deleting a pending one withdraws it; moving one in records it',
		async () => {
			const repo = uniqueName();
			await openIssue(h(), 'oscar', { repo });
			await setUpDiscussions(repo);
			const general = await introduce(repo, 'oscar', 'general');
			await settle(300);
			expect(await introductionsPage('?state=all')).not.toContain(`data-intro-key="${general.introKey}"`);

			await h().fakeGithub.editDiscussion({ owner: OWNER, repo, number: general.number, category: 'introductions' });
			await h().waitFor(async () => ((await introductionsPage()).includes(`data-intro-key="${general.introKey}"`) ? true : null), { message: 'moved in: recorded' });

			await h().fakeGithub.deleteDiscussion({ owner: OWNER, repo, number: general.number });
			await h().waitFor(async () => ((await introductionsPage('?state=withdrawn')).includes(`data-intro-key="${general.introKey}"`) ? true : null), { message: 'deleted: withdrawn' });
		},
		T
	);

	test(
		'an introduction in the org discussions repository lets them in to every repository of the owner',
		async () => {
			const before = await openIssue(h(), 'walter');
			await h().waitForSpan(actorFinished(before.address, 'closed'), { message: 'closed before the introduction' });
			await setUpDiscussions('.github');
			const s = await checkSetup();
			expect(s.entries.find((e) => e.repo === '.github')).toMatchObject({ org: true, state: 'ready' });

			const intro = await introduce('.github', 'walter');
			await h().waitFor(async () => ((await introductionsPage()).includes(`data-intro-key="${intro.introKey}"`) ? true : null));
			await remoteCommand(h(), cookie, '/introductions', 'approveIntroduction', { introKey: intro.introKey });
			await h().waitForSpan(actorFinished(introAddress(intro.repoId, intro.number), 'approved'));
			await h().waitFor(async () => ((await fakeIssue(h(), before)).state === 'open' ? true : null), { message: 'reopened in another repository of the owner' });

			const anywhere = await openIssue(h(), 'walter');
			await h().waitForSpan(actorFinished(anywhere.address, 'allowed'));
			const reply = (await h().fakeGithub.discussion(OWNER, '.github', intro.number))!.comments[0]!.body;
			expect(reply).toContain(`the repositories of ${OWNER}`);
		},
		T
	);
});
