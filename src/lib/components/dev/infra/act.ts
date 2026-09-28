/** Run one fake-infra control action with a toast (ADR 0139). */
import { toast } from 'svelte-sonner';
import { fakeInfraControl } from '$lib/remote/infra.remote';
import { describeError } from '$lib/components/app/format';
import type { FakeInfraAction, FakeInfraActionResult } from '$lib/schemas/dev';

export async function act(action: FakeInfraAction, success: string): Promise<FakeInfraActionResult | null> {
	try {
		const r = await fakeInfraControl(action);
		toast.success(success);
		return r;
	} catch (e) {
		toast.error('fake-infra action failed', { description: describeError(e).message });
		return null;
	}
}

export const bytes = (n: number): string =>
	n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`;
