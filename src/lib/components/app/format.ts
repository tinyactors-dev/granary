/**
 * Formatting helpers and UI-side constants (ADR 0052).
 *
 * The state lists mirror `src/lib/schemas/wal.ts` but are typed only against
 * it (type imports), so client bundles do not pull in TypeBox.
 */
import type { InboxState, OutboxState, VerdictValue } from '$lib/schemas/wal';
import type { AuthorAssociation } from '$lib/schemas/github';
import type { IssueSummary } from '$lib/schemas/api';

export const INBOX_STATES: readonly InboxState[] = ['pending', 'done', 'failed', 'ignored'];
export const OUTBOX_STATES: readonly OutboxState[] = ['pending', 'inflight', 'done', 'dead'];
export const VERDICT_VALUES: readonly VerdictValue[] = ['allowed', 'closed', 'failed'];
/** The associations offered by the dev "open issue" form. */
export const DEV_ASSOCIATIONS: readonly AuthorAssociation[] = [
	'NONE',
	'CONTRIBUTOR',
	'FIRST_TIME_CONTRIBUTOR',
	'MEMBER',
	'OWNER',
	'COLLABORATOR'
];

export const ISSUE_KEY_RE = /^[0-9]+-[0-9]+$/;

/** Tone of a state badge; see `StateBadge.svelte`. */
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

const TONES: Record<string, Tone> = {
	// inbox
	pending: 'warning',
	done: 'success',
	failed: 'danger',
	ignored: 'muted',
	// outbox
	inflight: 'info',
	dead: 'danger',
	// verdicts
	allowed: 'success',
	closed: 'info',
	// actors
	running: 'warning',
	idle: 'muted',
	ready: 'info',
	runnable: 'warning',
	quarantined: 'danger',
	none: 'muted',
	// fake GitHub deliveries
	delivered: 'success',
	open: 'success'
};

export const toneOf = (state: string): Tone => TONES[state] ?? 'muted';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * 24 * 3600_000],
	['month', 30 * 24 * 3600_000],
	['day', 24 * 3600_000],
	['hour', 3600_000],
	['minute', 60_000],
	['second', 1000]
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 minutes ago" / "in 20 seconds" relative to `now`. */
export function relativeTime(ms: number, now: number = Date.now()): string {
	const diff = ms - now;
	const abs = Math.abs(diff);
	if (abs < 5000) return diff <= 0 ? 'just now' : 'in a moment';
	for (const [unit, size] of UNITS) {
		if (abs >= size) return rtf.format(Math.round(diff / size), unit);
	}
	return rtf.format(Math.round(diff / 1000), 'second');
}

/** ISO-ish absolute timestamp for tooltips/`datetime`. */
export const isoTime = (ms: number): string => new Date(ms).toISOString();

export const absoluteTime = (ms: number): string =>
	new Date(ms).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'medium' });

export const issueLabel = (issue: Pick<IssueSummary, 'owner' | 'repo' | 'number'>): string =>
	`${issue.owner}/${issue.repo}#${issue.number}`;

export const issueHref = (issueKey: string): string => `/issues/${encodeURIComponent(issueKey)}`;

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
	return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function prettyJson(value: unknown): string {
	if (value === undefined) return 'undefined';
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Human message + status of anything a remote function can throw (HttpError or Error). */
export function describeError(error: unknown): { status: number | null; message: string } {
	const e = error as { status?: unknown; body?: { message?: unknown }; message?: unknown } | null;
	const status = typeof e?.status === 'number' ? e.status : null;
	const message =
		typeof e?.body?.message === 'string'
			? e.body.message
			: typeof e?.message === 'string'
				? e.message
				: String(error);
	return { status, message };
}

export function errorTitle(status: number | null): string {
	switch (status) {
		case 401:
			return 'Not signed in';
		case 403:
			return 'Not allowed';
		case 404:
			return 'Not found';
		case 409:
			return 'Conflict';
		case 502:
			return 'Upstream error';
		case 503:
			return 'Backend unavailable';
		default:
			return 'Something went wrong';
	}
}
