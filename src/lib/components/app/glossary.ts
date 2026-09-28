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
	blocklist: 'Blocked',
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

/** Kind badge text: short, for tables. */
export const KIND_SHORT: Record<ItemKind, string> = { issue: 'Issue', pull_request: 'PR' };

/**
 * Readable labels for every state code shown in a badge or filter pill
 * (ADR 0292). `stateLabel` falls back to the code in sentence case, so a new
 * state never shows up as a raw lowercase code.
 */
export const STATE_LABELS: Record<string, string> = {
	...ACTION_LABELS,
	// backups (runs and uploads)
	snapshotting: 'Taking snapshot',
	uploading: 'Uploading',
	finalizing: 'Finishing',
	succeeded: 'Succeeded',
	partial: 'Partly done',
	postponed: 'Postponed',
	'making-room': 'Making room',
	committing: 'Committing',
	verifying: 'Verifying',
	'retry-wait': 'Waiting to retry',
	failed: 'Failed',
	// ops overview / drills
	current: 'Current',
	stale: 'Overdue',
	passed: 'Passed',
	running: 'Running',
	// conditions and events
	ok: 'OK',
	suspect: 'Watching',
	healing: 'Fixing itself',
	attention: 'Needs you',
	acknowledged: 'Acknowledged',
	ack: 'Acknowledged',
	handled: 'Handled',
	info: 'Info',
	// switches and origins
	enabled: 'Enabled',
	disabled: 'Disabled',
	paused: 'Paused',
	seeded: 'From environment',
	configured: 'Configured',
	missing: 'Missing',
	'dev-generated': 'Development key',
	unknown: 'Unknown'
};

/** Telemetry sink connection (circuit breaker) states. */
export const SINK_STATE_LABELS: Record<string, string> = {
	idle: 'Healthy',
	closed: 'Healthy',
	sending: 'Sending',
	'half-open': 'Retrying',
	open: 'Paused after errors',
	disabled: 'Disabled',
	unknown: 'Unknown'
};

export function stateLabel(state: string): string {
	const known = STATE_LABELS[state];
	if (known) return known;
	const words = state.replace(/[-_.]+/g, ' ').trim();
	return words ? words[0]!.toUpperCase() + words.slice(1) : state;
}

const EVENT_NOUNS: Record<string, string> = {
	issues: 'Issue',
	pull_request: 'Pull request',
	issue_comment: 'Comment',
	installation: 'App installation',
	installation_repositories: 'Installation repositories',
	ping: 'Ping'
};

/** A webhook delivery as words: `issues` + `opened` → "Issue opened". */
export function deliveryLabel(event: string, action: string | null): string {
	const noun = EVENT_NOUNS[event] ?? stateLabel(event);
	if (!action) return noun;
	return `${noun} ${action.replace(/_/g, ' ')}`;
}

/** How a backup run was started. */
export const RUN_TRIGGER_LABELS: Record<string, string> = {
	schedule: 'Scheduled',
	manual: 'Started by hand',
	'catch-up': 'Catch-up',
	boot: 'At startup'
};
export const runTriggerLabel = (t: string): string => RUN_TRIGGER_LABELS[t] ?? stateLabel(t);
