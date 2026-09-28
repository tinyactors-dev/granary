/**
 * ops.sqlite access for the backups feature's tables (ADR 0089, 0110):
 * destinations, backup_plans, budgets, backup_runs, uploads, restore_drills,
 * egress, ops_audit (+ appends to ops_events). JSON columns are validated with
 * TypeBox on read and write. All multi-step writes are transactions.
 */
import type { Database } from 'bun:sqlite';
import type { OpsLogger } from '../contract';
import { Type, type Static } from '@sinclair/typebox';
import { parse, parseJson } from '../../schemas/standard';
import { OpsBackendError } from '../contract';
import type { BackupRunRow, BackupPlanRow, DestinationRow, RestoreDrillRow, UploadRow } from '../db/ddl';
import { DEFAULT_BUDGETS, Budgets } from '../schemas/budgets';
import { ConsoleUrl, DestinationSettings, RetentionCaps, RetentionSchedule, type Destination } from '../schemas/destinations';
import { BackupManifest } from '../schemas/manifest';
import type { BackupPlan } from '../schemas/plans';
import { RawSnapshot } from '../schemas/events';
import { StoreError, type BackupRunSummary, type RestoreDrillSummary, type RunState, type UploadState, type UploadSummary, type DrillResult } from '../schemas/runs';
import type { Page } from '../schemas/common';

export const DestinationConfig = Type.Object(
	{ settings: DestinationSettings, retention: RetentionSchedule, caps: RetentionCaps, consoleUrl: Type.Optional(ConsoleUrl) },
	{ additionalProperties: false }
);
export type DestinationConfig = Static<typeof DestinationConfig>;

export const PlanConfig = Type.Object(
	{
		databases: Type.Array(Type.String(), { minItems: 1 }),
		destinationIds: Type.Array(Type.String(), { minItems: 1 }),
		intervalMs: Type.Integer({ minimum: 5_000 }),
		drillIntervalMs: Type.Integer({ minimum: 60_000 })
	},
	{ additionalProperties: false }
);
export type PlanConfig = Static<typeof PlanConfig>;
export type RawSnapshot = Static<typeof RawSnapshot>;

const TERMINAL_UPLOADS: UploadState[] = ['done', 'failed'];

export function newId(prefix: string, now = Date.now()): string {
	const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => (b % 36).toString(36)).join('');
	return `${prefix}-${now.toString(36)}-${rand}`;
}

export const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);

export class BackupsRepo {
	constructor(
		readonly db: Database,
		readonly now: () => number,
		/** The running server's ops logger: audited changes are logged (ADR 0234); absent in the offline CLI. */
		readonly log: OpsLogger | null = null
	) {}

	tx<T>(fn: () => T): T {
		return this.db.transaction(fn)();
	}

	audit(actor: string, action: string, area: string, targetId: string | null, detail?: unknown): void {
		this.db.query('INSERT INTO ops_audit (at, actor, action, area, target_id, detail) VALUES (?,?,?,?,?,?)').run(
			this.now(), actor, action, area, targetId, detail === undefined ? null : JSON.stringify(detail)
		);
		this.log?.info(`audit: ${area}.${action} ${targetId ?? ''} by ${actor}`.replace('  ', ' '), { 'audit.action': `${area}.${action}`, 'audit.subject': targetId ?? undefined, 'audit.actor': actor });
	}

	/** ops_events is append-for-all (ADR 0110); backups write `info` and `handled` items. */
	event(kind: 'info' | 'handled' | 'attention', message: string, evidence?: unknown, conditionId: string | null = null): void {
		this.db.query('INSERT INTO ops_events (at, kind, condition_id, message, evidence) VALUES (?,?,?,?,?)').run(
			this.now(), kind, conditionId, message, evidence === undefined ? null : JSON.stringify(evidence)
		);
	}

	// ---- destinations -------------------------------------------------------

	destinationRows(): DestinationRow[] {
		return this.db.query('SELECT * FROM destinations ORDER BY created_at, id').all() as DestinationRow[];
	}

	destinationRow(id: string): DestinationRow | null {
		return (this.db.query('SELECT * FROM destinations WHERE id = ?').get(id) as DestinationRow | null) ?? null;
	}

	toDestination(r: DestinationRow): Destination {
		const c = parseJson(DestinationConfig, r.config, `destinations.config ${r.id}`);
		return {
			id: r.id,
			name: r.name,
			enabled: r.enabled === 1,
			origin: r.origin as Destination['origin'],
			version: r.version,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			settings: c.settings,
			retention: c.retention,
			caps: c.caps,
			...(c.consoleUrl ? { consoleUrl: c.consoleUrl } : {}),
			lastTest: r.last_test_at === null ? null : { at: r.last_test_at, ok: r.last_test_ok === 1, versionTested: r.last_test_version ?? 0 }
		};
	}

	destinations(): Destination[] {
		return this.destinationRows().map((r) => this.toDestination(r));
	}

	destination(id: string): Destination | null {
		const r = this.destinationRow(id);
		return r ? this.toDestination(r) : null;
	}

	requireDestination(id: string): Destination {
		const d = this.destination(id);
		if (!d) throw new OpsBackendError('not-found', `destination ${id} not found`);
		return d;
	}

	insertDestination(d: { id: string; name: string; enabled: boolean; origin: 'seed' | 'ui'; config: DestinationConfig }): void {
		const now = this.now();
		const config = JSON.stringify(parse(DestinationConfig, d.config, 'destination config'));
		this.db.query('INSERT INTO destinations (id, kind, name, enabled, origin, version, config, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)').run(
			d.id, d.config.settings.kind, d.name, d.enabled ? 1 : 0, d.origin, config, now, now
		);
	}

	updateDestination(id: string, fromVersion: number, d: { name: string; enabled: boolean; config: DestinationConfig; keepTest: boolean }): number {
		const config = JSON.stringify(parse(DestinationConfig, d.config, 'destination config'));
		const newVersion = fromVersion + 1;
		const res = this.db.query(
			`UPDATE destinations SET name=?, kind=?, enabled=?, origin='ui', version=?, config=?, updated_at=?,
			 last_test_version = CASE WHEN ? THEN ? ELSE last_test_version END WHERE id=? AND version=?`
		).run(d.name, d.config.settings.kind, d.enabled ? 1 : 0, newVersion, config, this.now(), d.keepTest ? 1 : 0, newVersion, id, fromVersion);
		if (res.changes !== 1) throw new OpsBackendError('conflict', `destination ${id} changed concurrently (expected version ${fromVersion})`);
		return newVersion;
	}

	/** Seeds may fill a missing console link on rows nobody edited (ADR 0154). */
	fillSeedConsoleUrl(id: string, url: string): boolean {
		const res = this.db
			.query(`UPDATE destinations SET config = json_set(config, '$.consoleUrl', ?) WHERE id = ? AND origin = 'seed' AND json_extract(config, '$.consoleUrl') IS NULL`)
			.run(url, id);
		return res.changes === 1;
	}

	recordDestinationTest(id: string, version: number, ok: boolean): void {
		this.db.query('UPDATE destinations SET last_test_at=?, last_test_ok=?, last_test_version=? WHERE id=?').run(this.now(), ok ? 1 : 0, version, id);
	}

	deleteDestination(id: string): void {
		this.db.query('DELETE FROM destinations WHERE id = ?').run(id);
	}

	// ---- plans --------------------------------------------------------------

	planRows(): BackupPlanRow[] {
		return this.db.query('SELECT * FROM backup_plans ORDER BY created_at, id').all() as BackupPlanRow[];
	}

	toPlan(r: BackupPlanRow): BackupPlan {
		const c = parseJson(PlanConfig, r.config, `backup_plans.config ${r.id}`);
		return {
			id: r.id,
			name: r.name,
			enabled: r.enabled === 1,
			origin: r.origin as BackupPlan['origin'],
			version: r.version,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			databases: c.databases,
			destinationIds: c.destinationIds,
			intervalMs: c.intervalMs,
			effectiveIntervalMs: r.effective_interval_ms,
			drillIntervalMs: c.drillIntervalMs
		};
	}

	plans(): BackupPlan[] {
		return this.planRows().map((r) => this.toPlan(r));
	}

	plan(id: string): BackupPlan | null {
		const r = this.db.query('SELECT * FROM backup_plans WHERE id = ?').get(id) as BackupPlanRow | null;
		return r ? this.toPlan(r) : null;
	}

	requirePlan(id: string): BackupPlan {
		const p = this.plan(id);
		if (!p) throw new OpsBackendError('not-found', `plan ${id} not found`);
		return p;
	}

	insertPlan(p: { id: string; name: string; enabled: boolean; origin: 'seed' | 'ui'; config: PlanConfig }): void {
		const now = this.now();
		const config = JSON.stringify(parse(PlanConfig, p.config, 'plan config'));
		this.db.query('INSERT INTO backup_plans (id, name, enabled, origin, version, config, effective_interval_ms, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?,?)').run(
			p.id, p.name, p.enabled ? 1 : 0, p.origin, config, p.config.intervalMs, now, now
		);
	}

	updatePlan(id: string, fromVersion: number, p: { name: string; enabled: boolean; config: PlanConfig }): void {
		const config = JSON.stringify(parse(PlanConfig, p.config, 'plan config'));
		const res = this.db.query(
			`UPDATE backup_plans SET name=?, enabled=?, origin='ui', version=version+1, config=?,
			 effective_interval_ms = ?, updated_at=? WHERE id=? AND version=?`
		).run(p.name, p.enabled ? 1 : 0, config, p.config.intervalMs, this.now(), id, fromVersion);
		if (res.changes !== 1) throw new OpsBackendError('conflict', `plan ${id} changed concurrently (expected version ${fromVersion})`);
	}

	setEffectiveInterval(id: string, ms: number): void {
		this.db.query('UPDATE backup_plans SET effective_interval_ms = ? WHERE id = ?').run(ms, id);
	}

	deletePlan(id: string): void {
		this.db.query('DELETE FROM backup_plans WHERE id = ?').run(id);
	}

	/** Last started run of a plan (schedules are derived from rows, ADR 0089). */
	lastStartedAt(planId: string): number | null {
		const r = this.db.query("SELECT max(started_at) AS t FROM backup_runs WHERE plan_id = ? AND trigger != 'manual'").get(planId) as { t: number | null };
		return r.t;
	}

	// ---- budgets ------------------------------------------------------------

	budgets(): Budgets {
		const r = this.db.query('SELECT config, version FROM budgets WHERE id = 1').get() as { config: string; version: number } | null;
		if (!r) return structuredClone(DEFAULT_BUDGETS);
		return { ...parseJson(Budgets, r.config, 'budgets.config'), version: r.version };
	}

	saveBudgets(b: Budgets): Budgets {
		const cur = this.budgets();
		if (b.version !== cur.version) throw new OpsBackendError('conflict', `budgets changed concurrently (expected version ${b.version}, is ${cur.version})`);
		const next = parse(Budgets, { ...b, version: cur.version + 1 }, 'budgets');
		this.db.query('INSERT INTO budgets (id, config, version, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config=excluded.config, version=excluded.version, updated_at=excluded.updated_at').run(
			JSON.stringify(next), next.version, this.now()
		);
		return next;
	}

	seedBudgets(b: Budgets): void {
		this.db.query('INSERT OR IGNORE INTO budgets (id, config, version, updated_at) VALUES (1, ?, ?, ?)').run(JSON.stringify(parse(Budgets, b, 'budgets')), b.version, this.now());
	}

	// ---- runs ---------------------------------------------------------------

	runRow(id: string): BackupRunRow | null {
		return (this.db.query('SELECT * FROM backup_runs WHERE id = ?').get(id) as BackupRunRow | null) ?? null;
	}

	insertRun(r: { id: string; planId: string; database: string; trigger: string; startedAt: number }): void {
		this.db.query("INSERT INTO backup_runs (id, plan_id, database, state, attempt, trigger, started_at, updated_at) VALUES (?,?,?,'pending',0,?,?,?)").run(
			r.id, r.planId, r.database, r.trigger, r.startedAt, r.startedAt
		);
	}

	setRunState(id: string, state: RunState, extra: { attemptInc?: boolean; error?: string | null } = {}): void {
		this.db.query(`UPDATE backup_runs SET state=?, attempt = attempt + ?, error = COALESCE(?, error), updated_at=? WHERE id=?`).run(
			state, extra.attemptInc ? 1 : 0, extra.error ?? null, this.now(), id
		);
	}

	setRunSnapshot(id: string, s: RawSnapshot): void {
		this.db.query('UPDATE backup_runs SET raw_path=?, raw_bytes=?, raw_sha256=?, snapshot=?, updated_at=? WHERE id=?').run(
			s.rawPath, s.rawBytes, s.rawSha256, JSON.stringify(parse(RawSnapshot, s, 'snapshot')), this.now(), id
		);
	}

	runSnapshot(r: BackupRunRow): RawSnapshot | null {
		return r.snapshot ? parseJson(RawSnapshot, r.snapshot, `backup_runs.snapshot ${r.id}`) : null;
	}

	finalizeRun(id: string, state: RunState, sealedBytes: number | null, error: string | null): void {
		const now = this.now();
		this.db.query('UPDATE backup_runs SET state=?, finished_at=?, sealed_bytes=COALESCE(?, sealed_bytes), error=COALESCE(?, error), updated_at=? WHERE id=?').run(
			state, now, sealedBytes, error, now, id
		);
	}

	/** Runs that still own a raw snapshot in the spool. */
	nonTerminalRunPaths(): string[] {
		return (this.db.query("SELECT raw_path FROM backup_runs WHERE raw_path IS NOT NULL AND state NOT IN ('succeeded','partial','failed','postponed')").all() as { raw_path: string }[]).map((r) => r.raw_path);
	}

	nonTerminalRuns(): BackupRunRow[] {
		return this.db.query("SELECT * FROM backup_runs WHERE state NOT IN ('succeeded','partial','failed','postponed')").all() as BackupRunRow[];
	}

	runSummary(r: BackupRunRow): BackupRunSummary {
		const ups = this.uploadRows(r.id);
		return {
			id: r.id,
			planId: r.plan_id,
			database: r.database,
			state: r.state as RunState,
			attempt: Math.max(1, r.attempt),
			trigger: r.trigger as BackupRunSummary['trigger'],
			startedAt: r.started_at,
			finishedAt: r.finished_at,
			rawBytes: r.raw_bytes,
			sealedBytes: r.sealed_bytes,
			destinations: ups.map((u) => ({ destinationId: u.destination_id, state: u.state as UploadState })),
			error: r.error
		};
	}

	listRuns(q: { planId?: string; state?: string; database?: string; limit: number; before?: string }): Page<BackupRunSummary> {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (q.planId) (where.push('plan_id = ?'), args.push(q.planId));
		if (q.state) (where.push('state = ?'), args.push(q.state));
		if (q.database) (where.push('database = ?'), args.push(q.database));
		if (q.before) {
			const [t, id] = q.before.split(':');
			where.push('(started_at < ? OR (started_at = ? AND id < ?))');
			args.push(Number(t), Number(t), id ?? '');
		}
		const rows = this.db.query(`SELECT * FROM backup_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, q.limit + 1) as BackupRunRow[];
		const more = rows.length > q.limit;
		const items = rows.slice(0, q.limit);
		const last = items.at(-1);
		return { items: items.map((r) => this.runSummary(r)), nextCursor: more && last ? `${last.started_at}:${last.id}` : null };
	}

	// ---- uploads ------------------------------------------------------------

	uploadRows(runId: string): UploadRow[] {
		return this.db.query('SELECT * FROM uploads WHERE run_id = ? ORDER BY destination_id').all(runId) as UploadRow[];
	}

	uploadRow(runId: string, destinationId: string): UploadRow | null {
		return (this.db.query('SELECT * FROM uploads WHERE run_id = ? AND destination_id = ?').get(runId, destinationId) as UploadRow | null) ?? null;
	}

	insertUpload(runId: string, destinationId: string): boolean {
		return this.db.query("INSERT OR IGNORE INTO uploads (run_id, destination_id, state, attempts, updated_at) VALUES (?,?,'pending',0,?)").run(runId, destinationId, this.now()).changes === 1;
	}

	setUploadState(runId: string, destinationId: string, state: UploadState, extra: { attemptInc?: boolean; attempts?: number; nextAttemptAt?: number | null; lastError?: StoreError | null; artifactKey?: string } = {}): void {
		this.db.query(
			`UPDATE uploads SET state=?, attempts = MAX(attempts + ?, ?), next_attempt_at = ?, last_error = CASE WHEN ? THEN ? ELSE last_error END,
			 artifact_key = COALESCE(?, artifact_key), updated_at=? WHERE run_id=? AND destination_id=?`
		).run(
			state, extra.attemptInc ? 1 : 0, extra.attempts ?? 0, extra.nextAttemptAt ?? null, extra.lastError !== undefined ? 1 : 0,
			extra.lastError ? JSON.stringify(parse(StoreError, extra.lastError, 'store error')) : null, extra.artifactKey ?? null, this.now(), runId, destinationId
		);
	}

	recordArtifact(runId: string, destinationId: string, manifest: BackupManifest, uploadedBytes: number): void {
		this.db.query("UPDATE uploads SET state='committing', manifest=?, artifact_key=?, uploaded_bytes=?, last_error=NULL, next_attempt_at=NULL, updated_at=? WHERE run_id=? AND destination_id=?").run(
			JSON.stringify(parse(BackupManifest, manifest, 'manifest')), manifest.artifactKey, uploadedBytes, this.now(), runId, destinationId
		);
	}

	/** Withdraw a manifest (un-commit) so the next attempt re-uploads the artifact. */
	clearManifest(runId: string, destinationId: string): void {
		this.db.query("UPDATE uploads SET manifest = NULL, state = 'uploading', updated_at = ? WHERE run_id = ? AND destination_id = ?").run(this.now(), runId, destinationId);
	}

	uploadManifest(u: UploadRow): BackupManifest | null {
		return u.manifest ? parseJson(BackupManifest, u.manifest, `uploads.manifest ${u.run_id}.${u.destination_id}`) : null;
	}

	uploadSummary(u: UploadRow): UploadSummary {
		return {
			runId: u.run_id,
			destinationId: u.destination_id,
			state: u.state as UploadState,
			attempts: u.attempts,
			nextAttemptAt: u.next_attempt_at,
			uploadedBytes: u.uploaded_bytes,
			artifactKey: u.artifact_key,
			lastError: u.last_error ? parseJson(StoreError, u.last_error, 'uploads.last_error') : null,
			updatedAt: u.updated_at
		};
	}

	isTerminalUpload(state: string): boolean {
		return (TERMINAL_UPLOADS as string[]).includes(state);
	}

	/** Committed (done) uploads to a destination, newest first. */
	doneUploads(destinationId: string, limit = 50): (UploadRow & { started_at: number; database: string })[] {
		return this.db.query(
			`SELECT u.*, r.started_at, r.database FROM uploads u JOIN backup_runs r ON r.id = u.run_id
			 WHERE u.destination_id = ? AND u.state = 'done' ORDER BY r.started_at DESC LIMIT ?`
		).all(destinationId, limit) as (UploadRow & { started_at: number; database: string })[];
	}

	/** Manifests of all committed uploads (for KEK accounting). */
	doneManifestKekIds(): string[] {
		return (this.db.query("SELECT manifest FROM uploads WHERE state = 'done' AND manifest IS NOT NULL").all() as { manifest: string }[]).map(
			(r) => (JSON.parse(r.manifest) as { encryption?: { kekId?: string } }).encryption?.kekId ?? ''
		);
	}

	// ---- drills -------------------------------------------------------------

	insertDrill(d: { id: string; destinationId: string; database: string }): void {
		this.db.query('INSERT INTO restore_drills (id, destination_id, database, started_at) VALUES (?,?,?,?)').run(d.id, d.destinationId, d.database, this.now());
	}

	setDrillRun(id: string, runId: string): void {
		this.db.query('UPDATE restore_drills SET run_id = ? WHERE id = ?').run(runId, id);
	}

	finishDrill(id: string, result: DrillResult, detail: string | null, rpoMs: number | null): void {
		const now = this.now();
		const r = this.db.query('SELECT started_at FROM restore_drills WHERE id = ?').get(id) as { started_at: number } | null;
		this.db.query('UPDATE restore_drills SET finished_at=?, result=?, detail=?, rpo_ms=?, rto_ms=? WHERE id=?').run(
			now, result, detail, rpoMs, r ? now - r.started_at : null, id
		);
	}

	drillRow(id: string): RestoreDrillRow | null {
		return (this.db.query('SELECT * FROM restore_drills WHERE id = ?').get(id) as RestoreDrillRow | null) ?? null;
	}

	drillSummary(r: RestoreDrillRow): RestoreDrillSummary {
		return {
			id: r.id,
			destinationId: r.destination_id,
			database: r.database,
			runId: r.run_id,
			startedAt: r.started_at,
			finishedAt: r.finished_at,
			result: (r.result as DrillResult | null) ?? null,
			detail: r.detail,
			rpoMs: r.rpo_ms,
			rtoMs: r.rto_ms
		};
	}

	listDrills(q: { destinationId?: string; limit: number; before?: string }): Page<RestoreDrillSummary> {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (q.destinationId) (where.push('destination_id = ?'), args.push(q.destinationId));
		if (q.before) {
			const [t, id] = q.before.split(':');
			where.push('(started_at < ? OR (started_at = ? AND id < ?))');
			args.push(Number(t), Number(t), id ?? '');
		}
		const rows = this.db.query(`SELECT * FROM restore_drills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, q.limit + 1) as RestoreDrillRow[];
		const more = rows.length > q.limit;
		const items = rows.slice(0, q.limit);
		const last = items.at(-1);
		return { items: items.map((r) => this.drillSummary(r)), nextCursor: more && last ? `${last.started_at}:${last.id}` : null };
	}

	lastDrillAt(destinationId: string): number | null {
		return (this.db.query('SELECT max(started_at) AS t FROM restore_drills WHERE destination_id = ?').get(destinationId) as { t: number | null }).t;
	}

	// ---- egress -------------------------------------------------------------

	addEgress(kind: string, bytes: number, at = this.now()): void {
		if (bytes <= 0) return;
		this.db.query('INSERT INTO egress (month, kind, bytes) VALUES (?,?,?) ON CONFLICT(month, kind) DO UPDATE SET bytes = bytes + excluded.bytes').run(monthKey(at), kind, bytes);
	}

	egressThisMonth(kinds: string[], at = this.now()): number {
		if (!kinds.length) return 0;
		const r = this.db.query(`SELECT coalesce(sum(bytes),0) AS b FROM egress WHERE month = ? AND kind IN (${kinds.map(() => '?').join(',')})`).get(monthKey(at), ...kinds) as { b: number };
		return r.b;
	}

	// ---- kv (key-prefixed by owner) ------------------------------------------

	kvGet(key: string): string | null {
		return ((this.db.query('SELECT value FROM kv WHERE key = ?').get(`backups:${key}`) as { value: string } | null) ?? null)?.value ?? null;
	}

	kvSet(key: string, value: string): void {
		this.db.query('INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(`backups:${key}`, value, this.now());
	}
}
