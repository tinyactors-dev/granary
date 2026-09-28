/**
 * Missed-webhook catch-up (ADR 0162, 0204): deliveries that failed while
 * granary was unreachable are found in the app's delivery log and
 * redelivered exactly once; the issue is closed exactly once.
 *
 * `todo` until E1 + E3 + E5 are in `build/` (see github-app.test.ts), and
 * until the catch-up timing can be shortened for tests: this file assumes
 * `GRANARY_CATCHUP_FIRST_DELAY_MS` / `GRANARY_CATCHUP_INTERVAL_MS` (E3/E6).
 */
import { describe, expect, test } from 'bun:test';
import { useHarness, type Harness } from './harness';
import { APP_MODE_ENV, setupAppMode } from './github-app';
import { expectClosedOnce, openIssue, OWNER, settle, waitClosedOnGithub } from './helpers';

const LIVE = process.env.GRANARY_TEST_PENDING === '1';
const live = LIVE ? test : test.todo;
const INTERVAL_MS = 1500;
const T = 90_000;

const h: () => Harness = !LIVE
	? () => {
			throw new Error('not live');
		}
	: useHarness({
			appEnv: { ...APP_MODE_ENV, GRANARY_CATCHUP_FIRST_DELAY_MS: '500', GRANARY_CATCHUP_INTERVAL_MS: String(INTERVAL_MS) }
		});

let appId = 0;

/** Redelivery attempts the fake logged for `guid`. */
async function redeliveries(guid: string) {
	return ((await h().fakeGithub.state()).appDeliveries ?? []).filter((d) => d.guid === guid && d.redelivery);
}

describe('catch-up', () => {
	live('setup', async () => {
		({ appId } = await setupAppMode(h(), OWNER));
		expect(appId).toBeGreaterThan(0);
	}, T);

	live(
		'webhook outage: the missed issues.opened is redelivered once and the issue closed once',
		async () => {
			await h().fakeGithub.webhookOutage(true);
			const i = await openIssue(h(), 'mallory', { expectAccepted: false });
			await h().fakeGithub.webhookOutage(false);
			const log = ((await h().fakeGithub.state()).appDeliveries ?? []).filter((d) => d.guid === i.deliveryId);
			expect(log.map((d) => d.statusCode)).toEqual([0]);

			const issue = await waitClosedOnGithub(h(), i, 30_000);
			expectClosedOnce(issue, i);
			expect(await redeliveries(i.deliveryId)).toHaveLength(1);
			// Later passes see it in the inbox and leave it alone.
			await settle(INTERVAL_MS * 3);
			expect(await redeliveries(i.deliveryId)).toHaveLength(1);
			expectClosedOnce(await waitClosedOnGithub(h(), i), i);
		},
		T
	);

	live(
		'granary down (SIGKILL): deliveries fail to connect; after restart catch-up closes the issue',
		async () => {
			await h().killApp('SIGKILL');
			const i = await openIssue(h(), 'mallory', { expectAccepted: false });
			await h().restartApp();
			const issue = await waitClosedOnGithub(h(), i, 30_000);
			expectClosedOnce(issue, i);
			expect(await redeliveries(i.deliveryId)).toHaveLength(1);
		},
		T
	);

	live(
		'delivered webhooks are never redelivered',
		async () => {
			const i = await openIssue(h(), 'mallory');
			await waitClosedOnGithub(h(), i);
			await settle(INTERVAL_MS * 3);
			expect(await redeliveries(i.deliveryId)).toHaveLength(0);
		},
		T
	);
});
