/**
 * Dev-only remote functions for the fake-infra portal page (ADR 0139).
 * Every function calls `requireDev()` first → 404 outside dev mode.
 */
import { command, query } from '$app/server';
import { standard } from '$lib/schemas/standard';
import { FakeInfraAction, type FakeInfraActionResult, type FakeInfraInfo } from '$lib/schemas/dev';
import { requireDev } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';

/** Reachability + full state of fake-infra (never errors when it is down). */
export const getFakeInfraStatus = query(async (): Promise<FakeInfraInfo> => {
	requireDev();
	return withBackend((b) => b.getFakeInfraStatus());
});

/** One control action; refreshes the status query. */
export const fakeInfraControl = command(standard(FakeInfraAction), async (action): Promise<FakeInfraActionResult> => {
	requireDev();
	const result = await withBackend((b) => b.fakeInfraControl(action));
	await getFakeInfraStatus().refresh();
	return result;
});
