/**
 * Pull request gating (ADR 0280–0283): pull requests from people who aren't
 * allowed are closed like issues, with one marked comment; the per-repo
 * pull request switch; and an app that lacks pull request access (created
 * before gating existed) — nothing is closed until the permission is granted
 * on GitHub and accepted on the installation.
 *
 * The scenarios run in order and share the harness' app.
 */
import { describe, expect, test } from 'bun:test';
import { runCli, useHarness, type Harness } from './harness';
import { consumeLoginLink, remoteCommand } from './github-app';
import { expectClosedOnce, expectUntouched, fakeIssue, openIssue, openPullRequest, OWNER, settle, waitClosedOnGithub } from './helpers';
import { actorFinished } from './traces';
import { CLOSING_COMMENT_PR } from '../src/lib/schemas/github';

const T = 60_000;
const h: () => Harness = useHarness();

let cookie = '';

interface StatusJson {
	pullRequests: { appPermission: boolean; appEvent: boolean; pendingInstallations: { installationId: number }[]; ready: boolean } | null;
	installations: { installationId: number; prAccess: boolean; repos: { repoId: number; prsEnabled: boolean; prAccess: boolean }[] }[];
}

async function githubStatus(): Promise<StatusJson> {
	const r = await runCli(h(), ['github', 'status', '--json']);
	expect(r.code).toBe(0);
	return JSON.parse(r.stdout) as StatusJson;
}

/** The harness' app and its installation on `acme` (auto-installed on first repo activity). */
async function appAndInstallation(): Promise<{ appId: number; installationId: number }> {
	const s = await h().fakeGithub.state();
	const app = (s.apps ?? [])[0]!;
	const inst = (s.installations ?? []).find((i) => i.appId === app.id && i.account === OWNER)!;
	return { appId: app.id, installationId: inst.id };
}

async function prClosedOnce(i: Awaited<ReturnType<typeof openPullRequest>>) {
	const pr = await waitClosedOnGithub(h(), i);
	expect(pr.pullRequest).toBeDefined();
	expect(pr.state).toBe('closed');
	expect(pr.state_reason ?? null).toBeNull(); // pull requests have no state_reason
	expect(pr.comments).toHaveLength(1);
	expect(pr.comments[0]!.body).toContain(i.marker);
	expect(pr.comments[0]!.body).toContain(CLOSING_COMMENT_PR);
}

describe('pull requests', () => {
	test(
		'a pull request from someone not allowed → closed with exactly one marked comment',
		async () => {
			const i = await openPullRequest(h(), 'mallory');
			await h().waitForSpan(actorFinished(i.address, 'closed'), { message: `${i.address.name} closed` });
			await prClosedOnce(i);
		},
		T
	);

	test(
		'a pull request from an allowlisted user stays open, untouched',
		async () => {
			const i = await openPullRequest(h(), 'alice');
			await h().waitForSpan(actorFinished(i.address, 'allowed'));
			await settle(500);
			expectUntouched(await fakeIssue(h(), i));
		},
		T
	);

	test(
		'draft pull requests are gated too',
		async () => {
			const i = await openPullRequest(h(), 'mallory', { draft: true });
			await prClosedOnce(i);
		},
		T
	);

	test(
		'per-repo pull request switch: off → pull requests ignored, issues still gated; on again → gated',
		async () => {
			const link = await runCli(h(), ['login-link', 'admin', '--json']);
			cookie = (await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url)).cookie;
			const first = await openPullRequest(h(), 'mallory');
			await prClosedOnce(first);
			await remoteCommand(h(), cookie, '/settings/github', 'setRepoEnabled', { repoId: first.repoId, enabled: false, kind: 'pull_requests' });
			const ignored = await openPullRequest(h(), 'mallory', { repo: first.repo });
			const issue = await openIssue(h(), 'mallory', { repo: first.repo });
			expectClosedOnce(await waitClosedOnGithub(h(), issue), issue);
			await settle(1500);
			expectUntouched(await fakeIssue(h(), ignored));
			await remoteCommand(h(), cookie, '/settings/github', 'setRepoEnabled', { repoId: first.repoId, enabled: true, kind: 'pull_requests' });
			const guarded = await openPullRequest(h(), 'mallory', { repo: first.repo });
			await prClosedOnce(guarded);
		},
		T
	);

	test(
		'an app without pull request access: status says so, the switch is locked, nothing is closed',
		async () => {
			const { appId, installationId } = await appAndInstallation();
			// Like an app created before pull request gating: issues only, accepted on the installation.
			await h().fakeGithub.setAppPermissions(appId, { permissions: { issues: 'write' }, events: ['issues'] });
			await h().fakeGithub.acceptPermissions(installationId);
			await remoteCommand(h(), cookie, '/settings/github', 'refreshGitHubInstallations', undefined);
			const s = await h().waitFor(
				async () => {
					const st = await githubStatus();
					return st.pullRequests && !st.pullRequests.appPermission ? st : undefined;
				},
				{ message: 'status reports missing pull request access', timeout: 20_000 }
			);
			expect(s.pullRequests!.ready).toBe(false);
			const inst = s.installations.find((x) => x.installationId === installationId)!;
			expect(inst.prAccess).toBe(false);
			expect(inst.repos.every((r) => !r.prAccess)).toBe(true);
			// GitHub doesn't deliver events the installation hasn't accepted; nothing to close.
			const i = await openPullRequest(h(), 'mallory', { expectDelivered: false });
			expect(i.delivered).toBe(false);
			await settle(1500);
			expectUntouched(await fakeIssue(h(), i));
			// Issues keep working meanwhile.
			const issue = await openIssue(h(), 'mallory');
			expectClosedOnce(await waitClosedOnGithub(h(), issue), issue);
		},
		T
	);

	test(
		'granting access (app permissions + accept on the installation) → pull requests are gated',
		async () => {
			const { appId, installationId } = await appAndInstallation();
			await h().fakeGithub.setAppPermissions(appId, {
				permissions: { issues: 'write', pull_requests: 'write' },
				events: ['issues', 'pull_request']
			});
			// The app asks, the installation hasn't accepted yet → still pending.
			await remoteCommand(h(), cookie, '/settings/github', 'refreshGitHubInstallations', undefined);
			const pending = await githubStatus();
			expect(pending.pullRequests).toMatchObject({ appPermission: true, appEvent: true, ready: false });
			expect(pending.pullRequests!.pendingInstallations.map((p) => p.installationId)).toContain(installationId);
			// The account accepts: granary hears `installation.new_permissions_accepted`.
			await h().fakeGithub.acceptPermissions(installationId);
			await h().waitFor(async () => ((await githubStatus()).pullRequests?.ready ? true : undefined), {
				message: 'pull request access ready',
				timeout: 20_000
			});
			const i = await openPullRequest(h(), 'mallory');
			await prClosedOnce(i);
		},
		T
	);
});
