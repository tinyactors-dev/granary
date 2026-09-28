/**
 * Formatting helpers and UI constants for the /ops pages (ADR 0141).
 * Type-only imports from the ops contract, so client bundles don't pull in
 * TypeBox (same rule as `$lib/components/app/format.ts`).
 */
import type {
	ConditionState,
	DestinationSettings,
	OpsEventKind,
	R2Jurisdiction,
	RunState,
	SecretKind,
	SinkAuth,
	UploadState
} from '$lib/ops/contract';
import type { Tone } from '$lib/components/app/format';

export const KiB = 1024;
export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Bytes with binary units, up to TiB. */
export function bytes(n: number | null | undefined): string {
	if (n === null || n === undefined) return '—';
	if (n < KiB) return `${n} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let v = n / KiB;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** "1 h", "90 min", "7 days", "41 s". */
export function duration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '—';
	if (ms < MINUTE) return `${Math.round(ms / 1000)} s`;
	if (ms < 2 * HOUR && ms % HOUR !== 0) return `${Math.round(ms / MINUTE)} min`;
	if (ms < 2 * DAY) return `${+(ms / HOUR).toFixed(1)} h`;
	return `${+(ms / DAY).toFixed(1)} days`;
}

export const percent = (ratio: number, digits = 0) => `${(ratio * 100).toFixed(digits)} %`;

/** R2's S3 endpoint for a jurisdiction (mirror of the contract's `r2Endpoint`, kept here to stay type-only). */
export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction): string {
	const j = jurisdiction === 'default' ? '' : `.${jurisdiction}`;
	return `https://${accountId || '<account-id>'}${j}.r2.cloudflarestorage.com`;
}

export const JURISDICTIONS: { value: R2Jurisdiction; label: string; hint: string }[] = [
	{ value: 'eu', label: 'EU', hint: 'Data stays in the EU. Must match how the bucket was created (ADR 0106).' },
	{ value: 'default', label: 'Default (global)', hint: 'Cloudflare picks the location.' },
	{ value: 'fedramp', label: 'FedRAMP', hint: 'US government jurisdiction; unusual for granary.' }
];

export const KIND_LABEL: Record<DestinationSettings['kind'], string> = {
	r2: 'Cloudflare R2',
	s3: 'S3-compatible',
	'local-dir': 'Local directory'
};

export function destinationWhere(s: DestinationSettings): string {
	switch (s.kind) {
		case 'r2':
			return `${s.bucket}/${s.prefix}`;
		case 's3':
			return `${s.endpoint.replace(/\/$/, '')}/${s.bucket}/${s.prefix}`;
		case 'local-dir':
			return s.path;
	}
}

export const SECRET_KIND_LABEL: Record<SecretKind, string> = {
	'r2-secret-access-key': 'R2 secret access key',
	's3-secret-access-key': 'S3 secret access key',
	'exe-vm-token': 'exe.dev VM token',
	'bearer-token': 'Bearer token',
	'basic-password': 'Basic auth password',
	'header-value': 'Header value'
};

export const AUTH_LABEL: Record<SinkAuth['mode'], string> = {
	'exe-peer': 'exe.dev VM-to-VM integration (no credential)',
	'exe-vm-token': 'exe.dev VM token',
	none: 'None',
	bearer: 'Bearer token',
	basic: 'Basic auth',
	header: 'Custom header'
};

/** Which secret kind a sink auth mode stores. */
export const AUTH_SECRET_KIND: Partial<Record<SinkAuth['mode'], SecretKind>> = {
	'exe-vm-token': 'exe-vm-token',
	bearer: 'bearer-token',
	basic: 'basic-password',
	header: 'header-value'
};

/** Condition states in calm language: nothing here pages (ADR 0100). */
export const CONDITION_STATE: Record<ConditionState, { label: string; tone: Tone }> = {
	ok: { label: 'ok', tone: 'success' },
	suspect: { label: 'watching', tone: 'info' },
	healing: { label: 'fixing itself', tone: 'info' },
	attention: { label: 'needs you', tone: 'warning' },
	acknowledged: { label: 'acknowledged', tone: 'muted' }
};

export const EVENT_KIND: Record<OpsEventKind, { label: string; tone: Tone }> = {
	info: { label: 'info', tone: 'muted' },
	handled: { label: 'handled', tone: 'success' },
	attention: { label: 'needs you', tone: 'warning' },
	ack: { label: 'acknowledged', tone: 'muted' }
};

const RUN_TONE: Record<RunState, Tone> = {
	pending: 'muted',
	snapshotting: 'info',
	uploading: 'info',
	finalizing: 'info',
	succeeded: 'success',
	partial: 'warning',
	failed: 'danger',
	postponed: 'muted'
};
export const runTone = (s: RunState): Tone => RUN_TONE[s];
export const RUN_STATES = Object.keys(RUN_TONE) as RunState[];

const UPLOAD_TONE: Record<UploadState, Tone> = {
	pending: 'muted',
	'making-room': 'info',
	uploading: 'info',
	committing: 'info',
	verifying: 'info',
	'retry-wait': 'warning',
	done: 'success',
	failed: 'danger'
};
export const uploadTone = (s: UploadState): Tone => UPLOAD_TONE[s];
/** Order of the happy path, for timelines. */
export const UPLOAD_STEPS: UploadState[] = ['pending', 'making-room', 'uploading', 'committing', 'verifying', 'done'];

export const drillTone = (result: string | null): Tone => (result === null ? 'info' : result === 'ok' ? 'success' : 'warning');

/** Interval presets for plans. */
export const INTERVAL_PRESETS = [
	{ ms: 15 * MINUTE, label: 'Every 15 minutes' },
	{ ms: 30 * MINUTE, label: 'Every 30 minutes' },
	{ ms: HOUR, label: 'Hourly (recommended)' },
	{ ms: 3 * HOUR, label: 'Every 3 hours' },
	{ ms: 6 * HOUR, label: 'Every 6 hours' },
	{ ms: 24 * HOUR, label: 'Daily' }
];
export const DRILL_PRESETS = [
	{ ms: DAY, label: 'Daily' },
	{ ms: 7 * DAY, label: 'Weekly (recommended)' },
	{ ms: 14 * DAY, label: 'Every two weeks' },
	{ ms: 30 * DAY, label: 'Monthly' }
];

/**
 * Split the server's validation message ("draft.settings.accountId: Expected …; …",
 * see `handleValidationError`) into issues keyed by the last path segment.
 */
export function fieldIssues(message: string, prefix = ''): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of message.split('; ')) {
		const i = part.indexOf(': ');
		if (i < 0) continue;
		const path = part.slice(0, i);
		if (prefix && !path.startsWith(prefix)) continue;
		const key = path.slice(prefix.length).replace(/^\./, '');
		if (!(key in out)) out[key] = humanize(part.slice(i + 2));
	}
	return out;
}

/** A friendlier wording for common TypeBox validation messages. */
export function humanize(m: string): string {
	if (/Expected string to match '\^\[0-9a-f\]\{32\}\$'/.test(m)) return 'Must be the 32-character hex account ID from the Cloudflare dashboard';
	if (/Expected string to match/.test(m)) return 'Has characters or a shape that is not allowed here';
	if (/Expected string length greater or equal to 1/.test(m)) return 'Required';
	return m;
}

/**
 * Client-side checks for destination settings, mirroring the patterns in
 * `$lib/ops/schemas/destinations.ts`. The server re-validates; this exists
 * because a union reports only "Expected union value" for its members.
 */
export function settingsIssues(s: DestinationSettings, secretMissing: boolean): Record<string, string> {
	const out: Record<string, string> = {};
	const prefixOk = (p: string) => /^([A-Za-z0-9._-]+\/)*$/.test(p) && p.length <= 200;
	if (s.kind === 'r2') {
		if (!/^[0-9a-f]{32}$/.test(s.accountId)) out.accountId = 'The 32-character hex account ID from the Cloudflare dashboard';
		if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(s.bucket)) out.bucket = '3–63 lower-case letters, digits and dashes';
	}
	if (s.kind === 's3') {
		// Same rule as the S3Settings schema: an optional path is allowed (e.g. a store mounted under /s3).
		if (!/^https?:\/\/[^\s/]+(:[0-9]+)?(\/[^\s]*)?$/.test(s.endpoint)) out.endpoint = 'A base URL such as https://s3.eu-central-1.amazonaws.com';
		if (!s.region.trim()) out.region = 'Required';
		if (s.bucket.length < 3 || s.bucket.length > 63) out.bucket = '3–63 characters';
	}
	if (s.kind === 'r2' || s.kind === 's3') {
		if (!prefixOk(s.prefix)) out.prefix = 'Empty, or path segments each ending in "/", e.g. prod/';
		if (!s.accessKeyId.trim()) out.accessKeyId = 'Required';
		if (secretMissing) out.secret = 'Pick a stored secret or paste a new one';
	}
	if (s.kind === 'local-dir' && !s.path.trim()) out.path = 'Required';
	return out;
}
