/**
 * User-facing names (ADR 0291). One glossary for the whole UI:
 *
 * - **Item**: an issue or a pull request.
 * - **Delivery**: a webhook GitHub sent about an item (the inbox).
 * - **Decision**: what granary decided for an item — allowed, closed or failed —
 *   and why (the verdict).
 * - **Action**: what granary does on GitHub for a closed item: comment, then
 *   close (the outbox).
 * - **Activity**: the list of items with their deliveries, decision and action.
 *
 * Internal names (inbox, outbox, verdict, effect, actor) stay in code, the
 * database, logs and the admin section.
 */
import type { ActivityOutcome, ItemKind } from '$lib/schemas/api';

export const OUTCOME_LABELS: Record<ActivityOutcome, string> = {
	allowed: 'Allowed',
	closed: 'Closed',
	failed: 'Failed',
	closing: 'Closing',
	pending: 'Deciding',
	ignored: 'Ignored'
};

export const KIND_LABELS: Record<ItemKind, string> = {
	issue: 'Issue',
	pull_request: 'Pull request'
};

/** Decision reasons (verdict `reason`), as sentences. */
export const REASON_LABELS: Record<string, string> = {
	allowlist: 'On the allowlist',
	association: 'Repository owner, member or collaborator',
	blocklist: 'On the blocklist',
	'not-allowed': 'Not on the allowlist',
	'check-timeout': 'The policy check timed out',
	'already-settled': 'Already decided earlier'
};

export const reasonLabel = (reason: string): string =>
	REASON_LABELS[reason] ?? (reason.startsWith('github-gave-up:') ? `Closing on GitHub failed repeatedly (${reason.slice('github-gave-up:'.length).trim()})` : reason);

/** Action (outbox) states. */
export const ACTION_LABELS: Record<string, string> = {
	pending: 'Waiting',
	inflight: 'Sending',
	done: 'Done',
	dead: 'Gave up'
};

/** Delivery (inbox) states. */
export const DELIVERY_LABELS: Record<string, string> = {
	pending: 'Processing',
	done: 'Processed',
	failed: 'Failed',
	ignored: 'Ignored'
};
