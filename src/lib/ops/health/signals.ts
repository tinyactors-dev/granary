/**
 * The watchdog's signals (ADR 0098, 0100, 0123): one pass reads host health,
 * the disk, ops.sqlite and the sinks, and returns a sample per condition.
 * Pure reads; no side effects. Thresholds are relative to what the VM
 * reports at runtime (ADR 0098), never hard-coded disk sizes.
 */
import { statfsSync, statSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { HostHealthSnapshot, OpsHost } from '../contract';
import { conditionId, type ConditionKind } from '../schemas/conditions';
import { GiB } from '../schemas/common';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SignalSample {
	conditionId: string;
	kind: ConditionKind;
	subject: string | null;
	breached: boolean;
	value: number | null;
	facts: Record<string, unknown>;
}

export interface SinkState {
	sinkId: string;
	state: string;
	openedAt: number | null;
	lastError: string | null;
	lastSuccessAt: number | null;
}

export interface DiskFacts {
	freeBytes: number;
	totalBytes: number;
	dbBytes: number;
	/** Reserve a backup needs besides the snapshot: max(1 GiB, 10 % of disk). */
	reserveBytes: number;
}

/** Everything one pass measured (also feeds metrics and status). */
export interface Measurements {
	at: number;
	host: HostHealthSnapshot | null;
	disk: DiskFacts | null;
	samples: SignalSample[];
}

export interface SamplerDeps {
	host: OpsHost;
	db: Database;
	now: () => number;
	sinks: () => SinkState[];
	/** When ops first started (kv), for "no webhook in 7 days" on a fresh install. */
	firstSeenAt: number;
}

export function readDisk(host: OpsHost): DiskFacts | null {
	let freeBytes: number;
	let totalBytes: number;
	const override = host.env.OPS_TEST_STATFS_OVERRIDE;
	try {
		if (override && /^[0-9]+\/[0-9]+$/.test(override)) {
			const [f, t] = override.split('/');
			freeBytes = Number(f);
			totalBytes = Number(t);
		} else {
			const s = statfsSync(host.dataDir);
			freeBytes = Number(s.bavail) * Number(s.bsize);
			totalBytes = Number(s.blocks) * Number(s.bsize);
		}
	} catch {
		return null;
	}
	let dbBytes = 0;
	for (const d of host.databases) {
		for (const p of [d.path, `${d.path}-wal`]) {
			try {
				dbBytes += statSync(p).size;
			} catch {
				/* absent */
			}
		}
	}
	return { freeBytes, totalBytes, dbBytes, reserveBytes: Math.max(GiB, Math.round(totalBytes * 0.1)) };
}

const s = (kind: ConditionKind, subject: string | null, breached: boolean, value: number | null, facts: Record<string, unknown>): SignalSample => ({
	conditionId: conditionId(kind, subject ?? undefined),
	kind,
	subject,
	breached,
	value,
	facts
});

interface DestRow {
	id: string;
	kind: string;
	enabled: number;
}
interface PlanRow {
	id: string;
	enabled: number;
	config: string;
	effective_interval_ms: number;
	created_at: number;
}

/** Tables of the backups feature may not be populated yet; every read is defensive. */
function all<T>(db: Database, sql: string, params: Record<string, unknown> = {}): T[] {
	try {
		return db.query(sql).all(params as never) as T[];
	} catch {
		return [];
	}
}
function one<T>(db: Database, sql: string, params: Record<string, unknown> = {}): T | null {
	try {
		return (db.query(sql).get(params as never) as T | null) ?? null;
	} catch {
		return null;
	}
}

export function measure(deps: SamplerDeps): Measurements {
	const now = deps.now();
	const { host, db } = deps;
	const out: SignalSample[] = [];
	let health: HostHealthSnapshot | null = null;
	try {
		health = host.health();
	} catch {
		health = null;
	}
	const disk = readDisk(host);

	const destinations = all<DestRow>(db, 'SELECT id, kind, enabled FROM destinations');
	const plans = all<PlanRow>(db, 'SELECT id, enabled, config, effective_interval_ms, created_at FROM backup_plans WHERE enabled = 1');
	const offsite = destinations.filter((d) => d.enabled === 1 && (d.kind === 'r2' || d.kind === 's3'));

	// --- disk (ADR 0098)
	if (disk) {
		const lowPct = disk.freeBytes < disk.totalBytes * 0.2;
		const low2x = disk.freeBytes < 2 * disk.dbBytes;
		out.push(s('disk-low', null, lowPct || low2x, disk.freeBytes, { ...disk }));
		const blocked = plans.length > 0 && disk.freeBytes - disk.dbBytes < disk.reserveBytes;
		out.push(s('backup-blocked-disk', null, blocked, disk.freeBytes - disk.dbBytes, { ...disk }));
	}

	// --- key material
	const keyMissing = !host.env.OPS_MASTER_KEY && !host.devMode;
	out.push(s('master-key', null, keyMissing, null, {}));

	// --- destinations & plans (tables owned by the backups feature)
	out.push(s('no-offsite-destination', null, offsite.length === 0, offsite.length, { destinations: destinations.length }));
	const offsiteIds = new Set(offsite.map((d) => d.id));
	for (const p of plans) {
		let destIds: string[] = [];
		try {
			destIds = (JSON.parse(p.config) as { destinationIds?: string[] }).destinationIds ?? [];
		} catch {
			/* invalid config: backups feature reports it */
		}
		const planOffsite = destIds.filter((id) => offsiteIds.has(id));
		if (!planOffsite.length) continue;
		const placeholders = planOffsite.map((_, i) => `$d${i}`).join(',');
		const params: Record<string, unknown> = { plan: p.id };
		planOffsite.forEach((id, i) => (params[`d${i}`] = id));
		const last = one<{ t: number | null }>(
			db,
			`SELECT MAX(u.updated_at) AS t FROM uploads u JOIN backup_runs r ON r.id = u.run_id
			 WHERE r.plan_id = $plan AND u.state = 'done' AND u.destination_id IN (${placeholders})`,
			params
		)?.t ?? null;
		const windowMs = 3 * Math.max(p.effective_interval_ms, 60_000);
		const reference = last ?? p.created_at;
		out.push(s('offsite-backup-stale', p.id, now - reference > windowMs, last ? now - last : null, { lastVerifiedAt: last, windowMs }));
	}
	// Retention floor vs cap: the backups feature records each pass in kv (ADR 0096, 0123).
	for (const d of destinations.filter((x) => x.enabled === 1)) {
		const row = one<{ value: string }>(db, 'SELECT value FROM kv WHERE key = $k', { k: `backups:retention:${d.id}` });
		if (!row) continue;
		let pass: { floorExceedsCap?: boolean; at?: number; freedBytes?: number } = {};
		try {
			pass = JSON.parse(row.value) as typeof pass;
		} catch {
			continue;
		}
		out.push(s('retention-floor-exceeds-cap', d.id, pass.floorExceedsCap === true, null, { lastPassAt: pass.at ?? null }));
	}
	for (const d of offsite) {
		const u = one<{ state: string; last_error: string | null }>(
			db,
			'SELECT state, last_error FROM uploads WHERE destination_id = $id ORDER BY updated_at DESC LIMIT 1',
			{ id: d.id }
		);
		let code: string | null = null;
		let providerCode: string | null = null;
		if (u?.last_error) {
			try {
				const e = JSON.parse(u.last_error) as { code?: string; providerCode?: string | null };
				code = e.code ?? null;
				providerCode = e.providerCode ?? null;
			} catch {
				/* ignore */
			}
		}
		const authBroken = !!u && (u.state === 'retry-wait' || u.state === 'failed') && (code === 'auth' || code === 'no-bucket');
		out.push(s('destination-auth', d.id, authBroken, null, { code, providerCode, uploadState: u?.state ?? null }));

		const drill = one<{ result: string | null; detail: string | null; finished_at: number | null }>(
			db,
			'SELECT result, detail, finished_at FROM restore_drills WHERE destination_id = $id AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
			{ id: d.id }
		);
		if (drill) out.push(s('restore-drill-failed', d.id, drill.result !== 'ok', null, { result: drill.result, detail: drill.detail, at: drill.finished_at }));
	}

	// --- telemetry sinks
	for (const sink of deps.sinks()) {
		const down = sink.state === 'open' || sink.state === 'half-open';
		out.push(s('telemetry-sink-down', sink.sinkId, down, sink.openedAt ? now - sink.openedAt : null, { lastError: sink.lastError, openedAt: sink.openedAt, lastSuccessAt: sink.lastSuccessAt }));
	}

	// --- granary (through OpsHost)
	if (health) {
		out.push(s('outbox-dead', null, health.outbox.dead > 0, health.outbox.dead, { dead: health.outbox.dead }));
		out.push(s('actors-quarantined', null, health.quarantinedActors > 0, health.quarantinedActors, { quarantined: health.quarantinedActors }));
		const age = health.outbox.oldestPendingAgeMs;
		out.push(s('outbox-pending-old', null, age !== null && age > HOUR, age, { oldestPendingAgeMs: age }));
		const lastWebhook = health.lastWebhookAt ?? deps.firstSeenAt;
		out.push(s('webhooks-silent', null, now - lastWebhook > 7 * DAY, now - lastWebhook, { lastWebhookAt: health.lastWebhookAt }));
	}

	return { at: now, host: health, disk, samples: out };
}
