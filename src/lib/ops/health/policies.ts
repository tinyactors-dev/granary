/**
 * Condition policies (ADR 0100, 0101, 0123): for each condition kind, the
 * self-healing ladder, how long it may persist before it needs a human
 * (`graceMs`), how long to wait after a remediation before judging it
 * (`settleMs`), and the plain-language texts for the morning.
 *
 * Nothing here pages anyone. `attention` only means "show it on the next
 * visit".
 */
import type { ConditionKind, RemediationAction } from '../schemas/conditions';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface ConditionPolicy {
	/** Remediations tried in order, one per settle period. */
	ladder: RemediationAction[];
	/** Minimum time since the condition started before `attention` (after the ladder). */
	graceMs: number;
	/** Wait after a remediation before trying the next step or escalating. */
	settleMs: number;
	/** Needs two consecutive breached samples before acting (filters blips). */
	confirm: boolean;
	title(subject: string | null, facts: Record<string, unknown>): string;
	/** What happened, what was tried, what to do. */
	explain(subject: string | null, facts: Record<string, unknown>, tried: RemediationAction[]): string;
}

const tried = (t: RemediationAction[]) => (t.length ? ` Already tried automatically: ${t.join(', ')}.` : '');
const fmtBytes = (n: unknown) => (typeof n === 'number' ? `${(n / 1024 ** 3).toFixed(1)} GiB` : 'unknown');

export const POLICIES: Record<ConditionKind, ConditionPolicy> = {
	'offsite-backup-stale': {
		ladder: ['retry-upload', 'stretch-interval'],
		graceMs: 12 * HOUR,
		settleMs: 30 * MIN,
		confirm: true,
		title: (s) => `No verified off-site backup for plan ${s ?? '?'}`,
		explain: (s, f, t) =>
			`Plan ${s} has no verified off-site backup within 3× its interval (last: ${f.lastVerifiedAt ? new Date(f.lastVerifiedAt as number).toISOString() : 'never'}).${tried(t)} Check the destination on /ops/destinations and the latest run on /ops/backups.`
	},
	'destination-auth': {
		ladder: [],
		graceMs: 2 * HOUR,
		settleMs: 0,
		confirm: true,
		title: (s) => `Storage credentials rejected by destination ${s ?? '?'}`,
		explain: (s, f) =>
			`Uploads to ${s} fail with ${String(f.code ?? 'an auth error')}${f.providerCode ? ` (${String(f.providerCode)})` : ''}. Backups are kept locally meanwhile and retried hourly. Replace the token on /ops/secrets and run the test connection.`
	},
	'restore-drill-failed': {
		ladder: ['rerun-drill'],
		graceMs: 0,
		settleMs: 2 * HOUR,
		confirm: false,
		title: (s) => `Restore drill failed for destination ${s ?? '?'}`,
		explain: (s, f, t) => `The latest restore drill from ${s} ended with "${String(f.result ?? 'failed')}"${f.detail ? `: ${String(f.detail)}` : ''}.${tried(t)} See /ops/drills.`
	},
	'backup-blocked-disk': {
		ladder: ['spool-cleanup', 'drop-local-copy', 'wal-checkpoint-truncate', 'postpone-backup'],
		graceMs: 0,
		settleMs: 2 * MIN,
		confirm: false,
		title: () => 'Not enough disk space to start a backup',
		explain: (_s, f, t) =>
			`Free space ${fmtBytes(f.freeBytes)} minus the database (${fmtBytes(f.dbBytes)}) is below the reserve of ${fmtBytes(f.reserveBytes)}.${tried(t)} Grow the disk: ssh exe.dev resize <vm> --disk=<size>.`
	},
	'disk-low': {
		ladder: ['spool-cleanup', 'drop-local-copy', 'wal-checkpoint-truncate'],
		graceMs: 24 * HOUR,
		settleMs: 5 * MIN,
		confirm: true,
		title: () => 'Disk space is low',
		explain: (_s, f, t) =>
			`Free ${fmtBytes(f.freeBytes)} of ${fmtBytes(f.totalBytes)} (below 20 % or 2× the database size).${tried(t)} Grow the disk: ssh exe.dev resize <vm> --disk=<size>.`
	},
	'retention-floor-exceeds-cap': {
		ladder: [],
		graceMs: 0,
		settleMs: 0,
		confirm: false,
		title: (s) => `Retention for ${s ?? '?'} cannot fit its size cap`,
		explain: (s) => `The backups that must always be kept at ${s} are larger than its size cap. Raise the cap or lower the schedule on /ops/destinations.`
	},
	'telemetry-sink-down': {
		ladder: ['reset-sink-circuit'],
		graceMs: 24 * HOUR,
		settleMs: 10 * MIN,
		confirm: true,
		title: (s) => `Telemetry sink ${s ?? '?'} is not accepting data`,
		explain: (s, f, t) =>
			`Exports to ${s} keep failing (${String(f.lastError ?? 'no detail')}); telemetry is buffered and the oldest is dropped.${tried(t)} Check the Grafana VM and the sink on /ops/telemetry.`
	},
	'outbox-dead': {
		ladder: [],
		graceMs: 0,
		settleMs: 0,
		confirm: false,
		title: (_s, f) => `${String(f.dead ?? 'Some')} GitHub action(s) gave up`,
		explain: () => 'The outbox relay retried these GitHub calls 6 times and gave up. Retry them from /effects once GitHub or the token is fine.'
	},
	'actors-quarantined': {
		ladder: [],
		graceMs: 0,
		settleMs: 0,
		confirm: false,
		title: (_s, f) => `${String(f.quarantined ?? 'Some')} actor(s) quarantined`,
		explain: () => 'An actor faulted and was quarantined. Inspect it on /actors.'
	},
	'outbox-pending-old': {
		ladder: [],
		graceMs: 6 * HOUR,
		settleMs: 0,
		confirm: true,
		title: () => 'GitHub actions have been pending for over an hour',
		explain: (_s, f) => `The oldest pending GitHub action is ${Math.round(Number(f.oldestPendingAgeMs ?? 0) / HOUR)} h old; the relay keeps retrying. Check GitHub status and the token.`
	},
	'webhooks-silent': {
		ladder: [],
		graceMs: 0,
		settleMs: 0,
		confirm: false,
		title: () => 'No webhook received for 7 days',
		explain: () => "granary hasn't received a GitHub webhook in a week. Check the webhook's recent deliveries in the repository settings."
	},
	'catchup-stale': {
		ladder: [],
		graceMs: HOUR,
		settleMs: 0,
		confirm: true,
		title: (_s, f) => (f.lastError ? 'Missed-webhook catch-up is failing' : 'Missed-webhook catch-up has not run recently'),
		explain: (_s, f) =>
			f.lastError
				? `The last catch-up pass failed: ${String(f.lastError)}. Webhooks GitHub could not deliver are not being re-sent. Check the GitHub App on /settings/github.`
				: "granary hasn't checked the GitHub App's delivery log for a while, so webhooks missed during downtime may not be re-sent. Check /settings/github."
	},
	'master-key': {
		ladder: [],
		graceMs: 0,
		settleMs: 0,
		confirm: false,
		title: () => 'Ops master key missing',
		explain: () => 'No master key (GRANARY_MASTER_KEY or <data>/master.key), so secrets cannot be read and encrypted backups cannot run. Run `granary init` or set GRANARY_MASTER_KEY, then restart.'
	},
	'no-offsite-destination': {
		ladder: [],
		graceMs: 0,
		settleMs: 0,
		confirm: false,
		title: () => 'No off-site backup destination',
		explain: () => 'Backups only exist on this VM. Add an R2 destination on /ops/destinations.'
	}
};

export const policyFor = (kind: ConditionKind): ConditionPolicy => POLICIES[kind];

/** Test hook: scale grace/settle periods (OPS_TEST_GRACE_SCALE, ADR 0123). */
export function scaled(ms: number, scale: number): number {
	return Math.round(ms * scale);
}
export { MIN, HOUR, DAY };
