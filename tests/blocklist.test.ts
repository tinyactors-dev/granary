/**
 * Blocklist (ADR 0260): blocklist > allowlist > association. Driven through
 * the CLI over the running server's admin socket; asserted through the
 * issue actors' traces (final state + `granary.done.reason`) and the fake
 * GitHub's state.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { runCli, useHarness } from './harness';
import { actorFinished } from './traces';
import { expectClosedOnce, expectUntouched, fakeIssue, openIssue, settle } from './helpers';

const h = useHarness();
const T = 60_000;

beforeEach(async () => {
	await h().fakeGithub.reset();
});

async function cli(args: string[]) {
	const r = await runCli(h(), [...args, '--json']);
	if (r.code !== 0) throw new Error(`granary ${args.join(' ')} exited ${r.code}: ${r.stderr}${r.stdout}`);
	return JSON.parse(r.stdout);
}

const reasonOf = (address: { family: string; name: string }) => h().index().sessionsAt(address).at(-1)?.doneReason;

describe('blocklist', () => {
	test(
		'an OWNER on the blocklist is closed with one comment, reason blocklist',
		async () => {
			const added = await cli(['blocklist', 'add', 'owner-self', '--note', 'self-test']);
			expect(added.added).toBe(true);
			expect(added.user).toMatchObject({ login: 'owner-self', active: true, expiresAt: null, note: 'self-test' });

			const i = await openIssue(h(), 'owner-self', { association: 'OWNER' });
			await h().waitForSpan(actorFinished(i.address, 'closed'), { message: `${i.address.name} closed` });
			expectClosedOnce(await fakeIssue(h(), i), i);
			expect(reasonOf(i.address)).toBe('blocklist');

			await cli(['blocklist', 'remove', 'owner-self']);
		},
		T
	);

	test(
		'blocklist beats the allowlist; removing the block restores it',
		async () => {
			await cli(['blocklist', 'add', 'alice']);
			const blocked = await openIssue(h(), 'alice');
			await h().waitForSpan(actorFinished(blocked.address, 'closed'));
			expectClosedOnce(await fakeIssue(h(), blocked), blocked);
			expect(reasonOf(blocked.address)).toBe('blocklist');

			const removed = await cli(['blocklist', 'remove', 'ALICE']);
			expect(removed).toEqual({ login: 'alice', removed: true });
			const allowed = await openIssue(h(), 'alice');
			await h().waitForSpan(actorFinished(allowed.address, 'allowed'));
			await settle(500);
			expectUntouched(await fakeIssue(h(), allowed));
			expect(reasonOf(allowed.address)).toBe('allowlist');
		},
		T
	);

	test(
		'a timed block expires by itself (no restart, no unblock)',
		async () => {
			const added = await cli(['blocklist', 'add', 'maint-timed', '--for', '4s']);
			expect(added.user.expiresAt).toBeGreaterThan(Date.now());

			const during = await openIssue(h(), 'maint-timed', { association: 'MEMBER' });
			await h().waitForSpan(actorFinished(during.address, 'closed'));
			expect(reasonOf(during.address)).toBe('blocklist');

			const waitMs = added.user.expiresAt - Date.now() + 250;
			if (waitMs > 0) await settle(waitMs);
			const list = await cli(['blocklist', 'list']);
			expect(list.find((b: { login: string }) => b.login === 'maint-timed')).toMatchObject({ active: false });

			const after = await openIssue(h(), 'maint-timed', { association: 'MEMBER' });
			await h().waitForSpan(actorFinished(after.address, 'allowed'));
			await settle(500);
			expectUntouched(await fakeIssue(h(), after));
			expect(reasonOf(after.address)).toBe('association');

			await cli(['blocklist', 'remove', 'maint-timed']);
		},
		T
	);

	test(
		'CLI: list, re-block replaces the expiry, invalid input is refused',
		async () => {
			await cli(['blocklist', 'add', 'spammer', '--for', '1h']);
			const again = await cli(['blocklist', 'add', 'spammer']);
			expect(again.added).toBe(false);
			expect(again.user.expiresAt).toBeNull();

			const human = await runCli(h(), ['blocklist', 'list']);
			expect(human.code).toBe(0);
			expect(human.stdout).toContain('spammer');
			expect(human.stdout).toContain('until removed');

			const bad = await runCli(h(), ['blocklist', 'add', '-not-a-login-']);
			expect(bad.code).not.toBe(0);
			const badDuration = await runCli(h(), ['blocklist', 'add', 'x', '--for', 'soon']);
			expect(badDuration.code).not.toBe(0);

			expect(await cli(['blocklist', 'remove', 'spammer'])).toEqual({ login: 'spammer', removed: true });
			expect(await cli(['blocklist', 'remove', 'spammer'])).toEqual({ login: 'spammer', removed: false });
		},
		T
	);
});
