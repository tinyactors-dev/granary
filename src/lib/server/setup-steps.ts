/**
 * The setup checklist (ADR 0240), computed from the real state so /settings
 * and `granary doctor` agree with /ops and /readyz:
 *
 * - admins     done when at least one admin exists
 * - github     done when GitHub is connected
 * - repos      done when at least one repository of a non-suspended
 *              installation is guarded (enabled)
 * - backups    done when an off-site destination has a verified backup within
 *              its window AND the latest restore drill passed: the backup half
 *              of the ops `sleepOk` rule (ADR 0100). `attention` when it worked
 *              before but has fallen behind, or the last drill failed.
 * - telemetry  optional; done when an enabled sink has delivered at least once
 *              and is not failing now
 */
import type { SetupStep } from '$lib/schemas/admins';
import type { GitHubStatus } from '$lib/schemas/github-app';
import type { OpsStatus } from '$lib/ops/contract';

export interface SetupInputs {
	adminCount: number;
	github: Pick<GitHubStatus, 'mode' | 'installations'>;
	/** null when the ops module is not running or its status could not be read. */
	ops: OpsStatus | null;
	/** Why `ops` is null, when reading it failed. */
	opsError?: string | null;
}

export function setupSteps(i: SetupInputs, now = Date.now()): SetupStep[] {
	return [adminsStep(i), githubStep(i), reposStep(i), backupStep(i, now), telemetryStep(i, now)];
}

function adminsStep(i: SetupInputs): SetupStep {
	const n = i.adminCount;
	return {
		id: 'admins',
		title: 'Admins',
		status: n > 0 ? 'done' : 'todo',
		optional: false,
		detail: n > 0 ? `${n} ${n === 1 ? 'admin' : 'admins'}` : 'No admin yet: run `granary admin add <login>` on the server',
		href: '/settings/admins'
	};
}

function githubStep(i: SetupInputs): SetupStep {
	const connected = i.github.mode !== 'none';
	return {
		id: 'github',
		title: 'GitHub',
		status: connected ? 'done' : 'todo',
		optional: false,
		detail: connected ? 'GitHub App connected' : 'Not connected: create the GitHub App',
		href: '/settings/github'
	};
}

function reposStep(i: SetupInputs): SetupStep {
	const base = { id: 'repos' as const, title: 'Guarded repositories', optional: false, href: '/settings/github' };
	if (i.github.mode === 'none') return { ...base, status: 'todo', detail: 'Connect GitHub first' };
	const active = i.github.installations.filter((inst) => !inst.suspended);
	if (active.length === 0)
		return { ...base, status: 'todo', detail: i.github.installations.length ? 'Every installation is suspended on GitHub' : 'The app is not installed on any account yet' };
	const repos = active.flatMap((inst) => inst.repos);
	const guarded = repos.filter((r) => r.enabled).length;
	const of = `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`;
	return guarded > 0
		? { ...base, status: 'done', detail: `${guarded} of ${of} guarded` }
		: { ...base, status: 'todo', detail: repos.length ? `None of ${of} is enabled` : 'The installation has no repositories yet' };
}

function backupStep(i: SetupInputs, now: number): SetupStep {
	const base = { id: 'backups' as const, title: 'Off-site backups', optional: false, href: '/ops/backups' };
	if (!i.ops) return { ...base, status: 'todo', detail: i.opsError ? `Ops status unavailable: ${i.opsError}` : 'The ops module is not running' };
	if (i.ops.mode === 'degraded') return { ...base, status: 'attention', detail: 'The master key is missing, so backups cannot run' };

	const offsite = i.ops.backups.filter((b) => b.offsite);
	if (offsite.length === 0)
		return { ...base, status: 'todo', detail: 'No off-site destination yet: add one (e.g. Cloudflare R2) under Ops → Destinations', href: '/ops/destinations' };

	const verified = offsite.filter((b) => b.lastVerifiedAt !== null && b.withinWindow);
	const drill = i.ops.lastDrill;
	const drillOk = drill !== null && drill.result === 'ok';
	if (verified.length > 0 && drillOk) {
		const newest = Math.max(...verified.map((b) => b.lastVerifiedAt!));
		return { ...base, status: 'done', detail: `Verified off-site backup ${ago(newest, now)}; last restore drill passed ${ago(drill.at, now)}` };
	}

	const everVerified = offsite.some((b) => b.lastVerifiedAt !== null);
	const missing: string[] = [];
	if (verified.length === 0) missing.push(everVerified ? 'no verified off-site backup within its window' : 'no verified off-site backup yet');
	if (drill === null) missing.push('no restore drill has run yet');
	else if (!drillOk) missing.push(`the last restore drill failed (${drill.result})`);
	// Before anything worked it is still to do; once it worked, falling behind needs attention.
	const regressed = (everVerified && verified.length === 0) || (drill !== null && !drillOk);
	return {
		...base,
		status: regressed ? 'attention' : 'todo',
		detail: capitalise(missing.join('; ')),
		href: verified.length > 0 && drill === null ? '/ops/drills' : '/ops/backups'
	};
}

function telemetryStep(i: SetupInputs, now: number): SetupStep {
	const base = { id: 'telemetry' as const, title: 'Telemetry', optional: true, href: '/ops/telemetry' };
	if (!i.ops) return { ...base, status: 'todo', detail: 'The ops module is not running' };
	const enabled = i.ops.telemetry.filter((t) => t.state !== 'disabled');
	if (enabled.length === 0) return { ...base, status: 'todo', detail: 'No telemetry sink enabled: send logs, traces and metrics to Grafana' };
	const delivering = enabled.filter((t) => t.lastSuccessAt !== null && t.state !== 'open');
	if (delivering.length > 0) {
		const newest = Math.max(...delivering.map((t) => t.lastSuccessAt!));
		return { ...base, status: 'done', detail: `${delivering.length} ${delivering.length === 1 ? 'sink' : 'sinks'} delivering; last delivery ${ago(newest, now)}` };
	}
	const failing = enabled.some((t) => t.state === 'open' || t.state === 'backoff' || t.state === 'half-open');
	return { ...base, status: failing ? 'attention' : 'todo', detail: failing ? 'Enabled but not delivering: check the sink under Ops → Telemetry' : 'Enabled; nothing delivered yet' };
}

function ago(at: number, now: number): string {
	const min = Math.round((now - at) / 60_000);
	if (min < 1) return 'just now';
	if (min < 120) return `${min} min ago`;
	const h = Math.round(min / 60);
	return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
