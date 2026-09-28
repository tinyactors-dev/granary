/**
 * Outbox effect actions (ADR 0003, ADR 0031).
 */
import { command, requested } from '$app/server';
import { standard } from '$lib/schemas/standard';
import { RetryEffectInput, type EffectSummary } from '$lib/schemas/api';
import { requireAdmin } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';
import { getIssue, getOverview, listEffects } from './dashboard.remote';

/**
 * Command `{effectKey}`. Admin only. `dead` (or backing-off `pending`) → `pending`,
 * attempts reset, relay kicked. 404 unknown key, 409 when `done`/`inflight`.
 * Refreshes `getOverview`, plus any `listEffects(...)` / `getIssue(...)`
 * instances the client passes via `.updates(...)`.
 */
export const retryEffect = command(standard(RetryEffectInput), async ({ effectKey }): Promise<EffectSummary> => {
	const admin = requireAdmin();
	const effect = await withBackend((b) => b.retryEffect(effectKey, admin.login));
	await Promise.all([
		getOverview().refresh(),
		requested(listEffects, 10).refreshAll(),
		requested(getIssue, 5).refreshAll()
	]);
	return effect;
});
