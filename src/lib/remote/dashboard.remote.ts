/**
 * Dashboard read models (ADR 0031). All require a signed-in user.
 */
import { query } from '$app/server';
import { standard } from '$lib/schemas/standard';
import {
	DEFAULT_PAGE_SIZE,
	GetIssueInput,
	ListDeliveriesInput,
	ListEffectsInput,
	ListVerdictsInput,
	ListActivityInput,
	type ActivityItem,
	type DeliverySummary,
	type EffectSummary,
	type IssueDetail,
	type Overview,
	type Page,
	type VerdictSummary
} from '$lib/schemas/api';
import { requireUser } from '$lib/server/auth';
import { withBackend } from '$lib/server/remote-helpers';

/** Counts per inbox/outbox state, verdict counts, allowlist size, actor-system stats. */
export const getOverview = query(async (): Promise<Overview> => {
	requireUser();
	return withBackend((b) => b.getOverview());
});

/** Inbox rows (webhook deliveries), newest first. Pass `{}` for the first page. */
export const listDeliveries = query(
	standard(ListDeliveriesInput),
	async (input): Promise<Page<DeliverySummary>> => {
		requireUser();
		return withBackend((b) => b.listDeliveries({ ...input, limit: input.limit ?? DEFAULT_PAGE_SIZE }));
	}
);

/** Outbox rows (GitHub side effects), newest first. */
export const listEffects = query(
	standard(ListEffectsInput),
	async (input): Promise<Page<EffectSummary>> => {
		requireUser();
		return withBackend((b) => b.listEffects({ ...input, limit: input.limit ?? DEFAULT_PAGE_SIZE }));
	}
);

/** Verdicts, newest first. */
export const listVerdicts = query(
	standard(ListVerdictsInput),
	async (input): Promise<Page<VerdictSummary>> => {
		requireUser();
		return withBackend((b) => b.listVerdicts({ ...input, limit: input.limit ?? DEFAULT_PAGE_SIZE }));
	}
);

/** Activity: one row per issue or pull request, newest first (ADR 0291). */
export const listActivity = query(
	standard(ListActivityInput),
	async (input): Promise<Page<ActivityItem>> => {
		requireUser();
		return withBackend((b) => b.listActivity({ ...input, limit: input.limit ?? DEFAULT_PAGE_SIZE }));
	}
);

/** Everything known about one issue; null if the key is unknown. */
export const getIssue = query(standard(GetIssueInput), async ({ issueKey }): Promise<IssueDetail | null> => {
	requireUser();
	return withBackend((b) => b.getIssue(issueKey));
});
