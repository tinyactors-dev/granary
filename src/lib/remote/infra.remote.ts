/**
 * Dev-only remote functions for the fake-infra portal page (ADR 0139).
 * Every function calls `requireAdminArea(<capability>)` first (ADR 0290): admins in every environment; 404 where the area isn't available.
 */
import { command, query } from '$app/server';
import { standard } from '$lib/schemas/standard';
import { FakeInfraAction, type FakeInfraActionResult, type FakeInfraInfo } from '$lib/schemas/dev';
import { requireAdminArea } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';

/** Reachability + full state of fake-infra (never errors when it is down). */
export const getFakeInfraStatus = query(async (): Promise<FakeInfraInfo> => {
	requireAdminArea('fakeInfra');
	return withBackend((b) => b.getFakeInfraStatus());
});

/** One control action; refreshes the status query. */
export const fakeInfraControl = command(standard(FakeInfraAction), async (action): Promise<FakeInfraActionResult> => {
	requireAdminArea('fakeInfra');
	const result = await withBackend((b) => b.fakeInfraControl(action));
	await getFakeInfraStatus().refresh();
	return result;
});
