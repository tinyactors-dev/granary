/**
 * In-memory OpsBackend with realistic data, for building the /ops UI before
 * the real module exists (ADR 0092). Registered only when
 * `GRANARY_STUB_OPS=1` (wiring is done by the UI agent in hooks). Mutations
 * are kept in memory. Touches nothing external.
 */
import {
	GiB,
	MiB,
	OpsBackendError,
	artifactKey,
	conditionId,
	r2Endpoint,
	type BackupManifest,
	type BackupPlan,
	type BackupPlanDraft,
	type BackupRunDetail,
	type BackupRunSummary,
	type Banner,
	type Budgets,
	type Condition,
	type ConfigExport,
	type Destination,
	type DestinationDraft,
	type DownloadLink,
	type ImportResult,
	type KeyStatus,
	type ListDrillsInput,
	type ListEventsInput,
	type ListRunsInput,
	type OpsActorSummary,
	type OpsBackend,
	type OpsEvent,
	type OpsStatus,
	type Page,
	type Projections,
	type Resolved,
	type RestoreDrillSummary,
	type RetentionPreview,
	type SecretMeta,
	type SetSecretInput,
	type TelemetrySinkConfig,
	type TelemetrySinkDraft,
	type TelemetryStats,
	type TestConnectionResult,
	type TestDestinationInput,
	type TestSinkInput,
	type UploadSummary
} from './contract';
import { DEFAULT_BUDGETS } from './schemas/budgets';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACCOUNT = '3f2a9c0b8d7e6f5a4b3c2d1e0f9a8b7c';
const sha = (s: string) => Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(s.charCodeAt(i % s.length) * (i + 7)) % 16]).join('');

export interface StubOpsBackendOptions {
	now?: () => number;
}

export class StubOpsBackend implements OpsBackend {
	readonly #now: () => number;
	#destinations: Destination[] = [];
	#plans: BackupPlan[] = [];
	#runs: BackupRunDetail[] = [];
	#drills: RestoreDrillSummary[] = [];
	#sinks: TelemetrySinkConfig[] = [];
	#secrets: SecretMeta[] = [];
	#conditions: Condition[] = [];
	#events: OpsEvent[] = [];
	#budgets: Budgets = structuredClone(DEFAULT_BUDGETS);
	#visits = new Map<string, number>();
	#seq = 1000;

	constructor(options: StubOpsBackendOptions = {}) {
		this.#now = options.now ?? (() => Date.now());
		this.#seed();
	}

	#id(prefix: string) {
		return `${prefix}-${(this.#seq++).toString(36)}`;
	}

	#seed() {
		const now = this.#now();
		const meta = (id: string, name: string, origin: 'seed' | 'ui') => ({ id, name, enabled: true, origin, version: 1, createdAt: now - 30 * DAY, updatedAt: now - 2 * DAY });
		this.#secrets = [
			{ id: 'r2-key', name: 'R2 token (granary-backups)', kind: 'r2-secret-access-key', fingerprint: '…9f1c · 7a02be', kekId: 'a1b2c3d4e5f60718', kekCurrent: true, createdAt: now - 30 * DAY, updatedAt: now - 30 * DAY, lastUsedAt: now - 20 * 60_000, lastUsedOk: true, usedBy: [{ area: 'destination', id: 'seed-r2' }] }
		];
		this.#destinations = [
			{
				...meta('seed-r2', 'Cloudflare R2 (EU)', 'seed'),
				settings: { kind: 'r2', accountId: ACCOUNT, jurisdiction: 'eu', bucket: 'granary-backups', prefix: 'prod/', accessKeyId: 'b41c0e2f9a7d4e61a0c3', secretAccessKey: { secretRef: 'r2-key' } },
				retention: { keepAllHours: 48, dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12, floor: 3 },
				caps: { maxBytes: 8 * GiB, maxBackupsPerDatabase: 82 },
				lastTest: { at: now - 2 * DAY, ok: true, versionTested: 1 }
			},
			{
				...meta('local', 'Local copy (same disk)', 'seed'),
				settings: { kind: 'local-dir', path: 'backups', maxCopies: 1 },
				retention: { keepAllHours: 1, dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0, floor: 1 },
				caps: { maxBytes: 2 * GiB, maxBackupsPerDatabase: 3 },
				lastTest: { at: now - 30 * DAY, ok: true, versionTested: 1 }
			}
		];
		this.#plans = [
			{ ...meta('seed-all', 'Hourly: granary + ops', 'seed'), databases: ['granary', 'ops'], destinationIds: ['seed-r2', 'local'], intervalMs: HOUR, effectiveIntervalMs: HOUR, drillIntervalMs: 7 * DAY }
		];
		this.#sinks = [
			{
				...meta('seed-otlp', 'Grafana on exe.dev (FRA)', 'seed'),
				kind: 'otlp-http',
				endpoint: 'https://grafana-otlp.int.exe.xyz',
				auth: { mode: 'exe-peer' },
				signals: ['traces', 'logs', 'metrics'],
				volumeBudgetBytesPerMonth: 5 * GiB,
				maxBufferBytes: 8 * MiB,
				flushIntervalMs: 2000,
				grafanaUrl: 'https://granary-grafana.exe.xyz/explore',
				lastTest: { at: now - 2 * DAY, ok: true, versionTested: 1 }
			}
		];
		// 36 hourly runs; one partial (R2 503s) 5 h ago, current one uploading
		for (let i = 35; i >= 0; i--) {
			for (const database of ['granary', 'ops'] as const) {
				const at = now - i * HOUR - 4 * 60_000;
				const runId = this.#id('run');
				const rawBytes = database === 'granary' ? 38 * MiB + i * 40_000 : 2 * MiB;
				const sealed = Math.round(rawBytes * 0.27);
				const state = i === 0 ? 'uploading' : i === 5 && database === 'granary' ? 'partial' : 'succeeded';
				const r2State = i === 0 ? 'uploading' : i === 5 && database === 'granary' ? 'failed' : 'done';
				const key = artifactKey('prod/', database, runId, at);
				const manifest: BackupManifest | null =
					state === 'uploading'
						? null
						: {
								format: 'granary-ops-backup/1', runId, database, createdAt: at, granaryVersion: '0.1.0', sqliteVersion: '3.51.0', userVersion: 3, pageCount: Math.round(rawBytes / 4096),
								rowCounts: database === 'granary' ? { inbox: 1200 + i, outbox: 310, verdicts: 1180, allowed_users: 14, sessions: 3 } : { destinations: 2, backup_runs: 70 - i, ops_events: 41 },
								raw: { bytes: rawBytes, sha256: sha(runId + 'r') }, compressed: { alg: 'zstd', level: 9, bytes: sealed - 64, sha256: sha(runId + 'c') }, sealed: { bytes: sealed, sha256: sha(runId + 's') },
								encryption: { alg: 'AES-256-GCM', chunkBytes: 4 * MiB, kekId: 'a1b2c3d4e5f60718', wrappedDek: 'q0v8b3VtZXdyYXBwZWRkZWtleQ==', nonceBase: 'bm9uY2ViYXNlMTI=' },
								artifactKey: key
							};
				const uploads: UploadSummary[] = [
					{ runId, destinationId: 'seed-r2', state: r2State, attempts: r2State === 'failed' ? 6 : 1, nextAttemptAt: null, uploadedBytes: r2State === 'done' ? sealed : r2State === 'uploading' ? Math.round(sealed / 2) : 0, artifactKey: key, lastError: r2State === 'failed' ? { code: 'server', retryable: true, status: 503, providerCode: 'ServiceUnavailable', message: 'R2 returned 503 Service Unavailable', retryAfterMs: null } : null, updatedAt: at + 90_000 },
					{ runId, destinationId: 'local', state: i === 0 ? 'done' : 'done', attempts: 1, nextAttemptAt: null, uploadedBytes: sealed, artifactKey: `backups/${runId}.sqlite.zst.aesgcm`, lastError: null, updatedAt: at + 20_000 }
				];
				this.#runs.unshift({
					run: { id: runId, planId: 'seed-all', database, state, attempt: 1, trigger: 'schedule', startedAt: at, finishedAt: state === 'uploading' ? null : at + 95_000, rawBytes, sealedBytes: sealed, destinations: uploads.map((u) => ({ destinationId: u.destinationId, state: u.state })), error: state === 'partial' ? 'seed-r2: gave up after 6 attempts (503)' : null },
					uploads,
					manifest
				});
			}
		}
		this.#drills = [0, 7, 14].map((d, i) => ({ id: this.#id('drill'), destinationId: 'seed-r2', database: 'granary', runId: this.#runs[10 + i]!.run.id, startedAt: now - d * DAY - 3 * HOUR, finishedAt: now - d * DAY - 3 * HOUR + 41_000, result: 'ok', detail: 'integrity_check ok; 5 tables, row counts match', rpoMs: 52 * 60_000, rtoMs: 41_000 }));
		this.#conditions = [
			this.#condition('offsite-backup-stale', 'seed-all', 'ok', 'Off-site backups are current', 'Latest verified R2 backup is 64 minutes old (window: 3 h).', []),
			this.#condition('destination-auth', 'seed-r2', 'ok', 'R2 credentials work', 'Last successful upload 20 minutes ago.', []),
			this.#condition('disk-low', undefined, 'ok', 'Disk has room', '15.8 GiB free of 25 GiB (63 %).', ['spool-cleanup', 'drop-local-copy', 'wal-checkpoint-truncate']),
			this.#condition('telemetry-sink-down', 'seed-otlp', 'ok', 'Telemetry reaches Grafana', 'Last export 3 s ago.', ['reset-sink-circuit']),
			this.#condition('outbox-dead', undefined, 'attention', '1 GitHub action gave up', 'The relay could not close issue acme/widgets#42 after 6 attempts (GitHub returned 403). Open Effects → retry once the token is fixed.', [])
		];
		this.#conditions.at(-1)!.since = now - 7 * HOUR;
		this.#events = [
			{ id: 'e5', at: now - 5 * HOUR + 60_000, kind: 'handled', conditionId: 'destination-auth.seed-r2', message: 'R2 returned 503 for 9 minutes; the upload was retried 6 times, then the next hourly backup succeeded.', evidence: { runId: this.#runs[10]!.run.id } },
			{ id: 'e4', at: now - 7 * HOUR, kind: 'attention', conditionId: 'outbox-dead', message: '1 GitHub action gave up (acme/widgets#42).', evidence: { effectKey: 'close:1790584260717:42' } },
			{ id: 'e3', at: now - 9 * HOUR, kind: 'handled', conditionId: 'disk-low', message: 'Spool cleanup removed 2 leftover snapshots (78 MiB).', evidence: {} },
			{ id: 'e2', at: now - 26 * HOUR, kind: 'handled', conditionId: 'telemetry-sink-down.seed-otlp', message: 'Grafana VM unreachable for 4 min; 312 KiB of telemetry buffered and delivered, nothing dropped.', evidence: {} },
			{ id: 'e1', at: now - 3 * DAY, kind: 'info', conditionId: null, message: 'Restore drill passed for R2 (granary, 41 s).', evidence: {} }
		];
	}

	#condition(kind: Condition['kind'], subject: string | undefined, state: Condition['state'], title: string, explanation: string, remediations: Condition['remediations']): Condition {
		return { id: conditionId(kind, subject), kind, subject: subject ?? null, state, title, explanation, since: state === 'ok' ? null : this.#now(), gracePeriodMs: 2 * HOUR, remediations, lastRemediation: null, acknowledgedBy: null, facts: {} };
	}

	#page<T>(items: T[], limit: number, before: string | undefined, key: (t: T) => string): Page<T> {
		const start = before ? items.findIndex((t) => key(t) === before) + 1 : 0;
		const slice = items.slice(start, start + limit);
		return { items: slice, nextCursor: start + limit < items.length ? key(slice.at(-1)!) : null };
	}

	#find<T extends { id: string }>(list: T[], id: string, what: string): T {
		const x = list.find((t) => t.id === id);
		if (!x) throw new OpsBackendError('not-found', `${what} ${id} not found`);
		return x;
	}

	async getStatus(): Promise<OpsStatus> {
		const now = this.#now();
		const attention = this.#conditions.filter((c) => c.state === 'attention');
		const lastOk = (db: string, dest: string) => this.#runs.find((r) => r.run.database === db && r.uploads.some((u) => u.destinationId === dest && u.state === 'done'));
		const backups = ['granary', 'ops'].flatMap((database) =>
			this.#destinations.map((d) => {
				const r = lastOk(database, d.id);
				return { database, destinationId: d.id, destinationKind: d.settings.kind, offsite: d.settings.kind !== 'local-dir', lastVerifiedAt: r?.run.startedAt ?? null, lastVerifiedBytes: r?.run.sealedBytes ?? null, withinWindow: !!r && now - r.run.startedAt < 3 * HOUR };
			})
		);
		// The newest *finished* drill: a running one has no result yet (OpsStatus.lastDrill needs one).
		const d = this.#drills.find((x) => x.finishedAt !== null && x.result !== null) ?? null;
		return {
			at: now,
			mode: 'ok',
			sleepOk: attention.length === 0,
			reasons: attention.map((c) => c.title),
			attentionCount: attention.length,
			handledLast24h: this.#events.filter((e) => e.kind === 'handled' && now - e.at < DAY).length,
			backups,
			lastDrill: d ? { at: d.finishedAt!, result: d.result!, destinationId: d.destinationId } : null,
			telemetry: this.#sinks.map((s) => ({ sinkId: s.id, state: 'idle', lastSuccessAt: now - 3000, droppedLast24h: 0 }))
		};
	}

	async getBanner(login: string): Promise<Banner> {
		const since = this.#visits.get(login.toLowerCase()) ?? this.#now() - DAY;
		const handled = this.#events.filter((e) => e.kind === 'handled' && e.at > since).length;
		const attention = this.#conditions.filter((c) => c.state === 'attention').map((c) => ({ id: c.id, title: c.title, since: c.since }));
		const summary = `Since ${new Date(since).toISOString().slice(11, 16)} UTC: ${handled} thing${handled === 1 ? '' : 's'} handled automatically, ${attention.length} need${attention.length === 1 ? 's' : ''} you.`;
		return { since, handledCount: handled, attention, summary, show: handled > 0 || attention.length > 0 };
	}

	async markVisited(login: string) {
		this.#visits.set(login.toLowerCase(), this.#now());
	}

	async listConditions() {
		return structuredClone(this.#conditions);
	}

	async acknowledgeCondition(id: string, actor: string) {
		const c = this.#find(this.#conditions, id, 'condition');
		if (c.state !== 'attention') throw new OpsBackendError('conflict', `condition ${id} is ${c.state}, not attention`);
		c.state = 'acknowledged';
		c.acknowledgedBy = actor;
		this.#events.unshift({ id: this.#id('e'), at: this.#now(), kind: 'ack', conditionId: id, message: `${actor} acknowledged "${c.title}"`, evidence: {} });
		return structuredClone(c);
	}

	async listEvents(q: Resolved<ListEventsInput>) {
		return this.#page(this.#events.filter((e) => !q.kind || e.kind === q.kind), q.limit, q.before, (e) => e.id);
	}

	async listDestinations() {
		return structuredClone(this.#destinations);
	}

	async saveDestination(draft: DestinationDraft, actor: string): Promise<Destination> {
		const now = this.#now();
		if (draft.id) {
			const d = this.#find(this.#destinations, draft.id, 'destination');
			if (draft.version !== d.version) throw new OpsBackendError('conflict', `destination ${d.id} changed (version ${d.version})`);
			const enabling = draft.enabled && !d.enabled;
			if (enabling && !(d.lastTest?.ok && d.lastTest.versionTested === d.version)) throw new OpsBackendError('invalid', 'run a successful test connection before enabling');
			Object.assign(d, { name: draft.name, enabled: draft.enabled, settings: draft.settings, retention: draft.retention, caps: draft.caps, consoleUrl: draft.consoleUrl, version: d.version + 1, updatedAt: now, origin: 'ui' });
			if (!draft.consoleUrl) delete d.consoleUrl;
			return structuredClone(d);
		}
		const d: Destination = { id: this.#id('dest'), name: draft.name, enabled: false, origin: 'ui', version: 1, createdAt: now, updatedAt: now, settings: draft.settings, retention: draft.retention, caps: draft.caps, ...(draft.consoleUrl ? { consoleUrl: draft.consoleUrl } : {}), lastTest: null };
		this.#destinations.push(d);
		void actor;
		return structuredClone(d);
	}

	async deleteDestination(id: string) {
		this.#find(this.#destinations, id, 'destination');
		if (this.#plans.some((p) => p.destinationIds.includes(id))) throw new OpsBackendError('conflict', 'destination is used by a plan');
		this.#destinations = this.#destinations.filter((d) => d.id !== id);
	}

	async testDestination(input: TestDestinationInput): Promise<TestConnectionResult> {
		const settings = input.draft?.settings ?? this.#find(this.#destinations, input.id ?? '', 'destination').settings;
		const endpoint = settings.kind === 'r2' ? r2Endpoint(settings.accountId, settings.jurisdiction) : settings.kind === 's3' ? settings.endpoint : null;
		const steps = ['PUT probe', 'HEAD probe', 'LIST prefix', 'GET probe', 'PUT If-None-Match (expect 412)', 'DELETE probe', 'HEAD probe (expect 404)'].map((name, i) => ({ name, ok: true, skipped: settings.kind === 'local-dir' && i === 4, durationMs: 40 + i * 13, detail: null, providerCode: null }));
		if (input.id) {
			const d = this.#destinations.find((x) => x.id === input.id);
			if (d) d.lastTest = { at: this.#now(), ok: true, versionTested: d.version };
		}
		return {
			ok: true,
			at: this.#now(),
			resolvedEndpoint: endpoint,
			steps,
			advisories:
				settings.kind === 'r2'
					? [
							{ title: 'Keep the default multipart cleanup rule', detail: 'R2 buckets expire incomplete multipart uploads after 7 days by default. Keep it.', docsUrl: 'https://developers.cloudflare.com/r2/buckets/object-lifecycles/' },
							{ title: 'No lifecycle rule may delete under this prefix', detail: 'Retention is managed by granary (caps + GFS).', docsUrl: null },
							{ title: 'Token scope', detail: 'Object Read & Write, this bucket only; no Admin permissions.', docsUrl: 'https://developers.cloudflare.com/r2/api/tokens/' }
						]
					: []
		};
	}

	async previewRetention(destinationId: string): Promise<RetentionPreview> {
		const d = this.#find(this.#destinations, destinationId, 'destination');
		const done = this.#runs.filter((r) => r.uploads.some((u) => u.destinationId === destinationId && u.state === 'done'));
		const keep = done.map((r) => ({ key: r.manifest?.artifactKey ?? r.run.id, database: r.run.database, createdAt: r.run.startedAt, bytes: r.run.sealedBytes ?? 0, reason: 'hourly (< 48 h)' }));
		const del = [{ key: 'prod/granary/2026/08/01/run-old.sqlite.zst.aesgcm', database: 'granary', createdAt: this.#now() - 58 * DAY, bytes: 9 * MiB, reason: 'beyond 8 weekly slots' }];
		return { destinationId, at: this.#now(), keep, delete: d.settings.kind === 'r2' ? del : [], unknownObjects: 0, totalBytesAfter: keep.reduce((a, k) => a + k.bytes, 0), backupsAfterPerDatabase: { granary: keep.filter((k) => k.database === 'granary').length, ops: keep.filter((k) => k.database === 'ops').length }, floorExceedsCap: false };
	}

	async getProjections(destinationId: string): Promise<Projections> {
		const d = this.#find(this.#destinations, destinationId, 'destination');
		const avg = 11 * MiB;
		const steady = d.caps.maxBackupsPerDatabase * 2;
		const offsite = d.settings.kind !== 'local-dir';
		return {
			destinationId,
			storage: { steadyStateBackups: steady, averageSealedBytes: avg, steadyStateBytes: steady * avg, capBytes: d.caps.maxBytes, capBackupsPerDatabase: d.caps.maxBackupsPerDatabase, monthsUntilCap: offsite ? 31 : null, explanation: `${steady} backups × ${(avg / MiB).toFixed(0)} MiB ≈ ${((steady * avg) / GiB).toFixed(1)} GiB of ${(d.caps.maxBytes / GiB).toFixed(0)} GiB. At the current growth the cap is reached in ~31 months; then the oldest monthly backups are dropped first.` },
			egress: offsite ? { usedThisMonthBytes: Math.round(6.2 * GiB), projectedMonthBytes: Math.round(7.9 * GiB), budgetBytes: this.#budgets.r2EgressBytesPerMonth, configuredIntervalMs: HOUR, effectiveIntervalMs: HOUR, stretched: false, explanation: 'Hourly uploads of ~11 MiB ≈ 7.9 GiB this month, within the 20 GiB budget (R2 uploads are billed exe.dev egress).' } : null
		};
	}

	async listPlans() {
		return structuredClone(this.#plans);
	}

	async savePlan(draft: BackupPlanDraft): Promise<BackupPlan> {
		const now = this.#now();
		for (const id of draft.destinationIds) this.#find(this.#destinations, id, 'destination');
		if (draft.id) {
			const p = this.#find(this.#plans, draft.id, 'plan');
			if (draft.version !== p.version) throw new OpsBackendError('conflict', `plan ${p.id} changed`);
			Object.assign(p, { ...draft, version: p.version + 1, updatedAt: now, origin: 'ui', effectiveIntervalMs: draft.intervalMs });
			return structuredClone(p);
		}
		const p: BackupPlan = { id: this.#id('plan'), name: draft.name, enabled: draft.enabled, origin: 'ui', version: 1, createdAt: now, updatedAt: now, databases: draft.databases, destinationIds: draft.destinationIds, intervalMs: draft.intervalMs, effectiveIntervalMs: draft.intervalMs, drillIntervalMs: draft.drillIntervalMs };
		this.#plans.push(p);
		return structuredClone(p);
	}

	async deletePlan(id: string) {
		this.#find(this.#plans, id, 'plan');
		this.#plans = this.#plans.filter((p) => p.id !== id);
	}

	async runBackupNow(planId: string): Promise<BackupRunSummary[]> {
		const plan = this.#find(this.#plans, planId, 'plan');
		const now = this.#now();
		return plan.databases.map((database) => {
			const run: BackupRunSummary = { id: this.#id('run'), planId, database, state: 'snapshotting', attempt: 1, trigger: 'manual', startedAt: now, finishedAt: null, rawBytes: null, sealedBytes: null, destinations: plan.destinationIds.map((destinationId) => ({ destinationId, state: 'pending' as const })), error: null };
			this.#runs.unshift({ run, uploads: [], manifest: null });
			return structuredClone(run);
		});
	}

	async listRuns(q: Resolved<ListRunsInput>) {
		const items = this.#runs.map((r) => r.run).filter((r) => (!q.planId || r.planId === q.planId) && (!q.state || r.state === q.state) && (!q.database || r.database === q.database));
		return structuredClone(this.#page(items, q.limit, q.before, (r) => r.id));
	}

	async getRun(runId: string) {
		return structuredClone(this.#runs.find((r) => r.run.id === runId) ?? null);
	}

	async getDownloadLink(runId: string, destinationId: string): Promise<DownloadLink> {
		const r = this.#runs.find((x) => x.run.id === runId);
		const u = r?.uploads.find((x) => x.destinationId === destinationId && x.state === 'done');
		if (!r || !u) throw new OpsBackendError('not-found', 'no committed backup for that run/destination');
		return { url: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com/granary-backups/${u.artifactKey}?X-Amz-Expires=300&X-Amz-Signature=stub`, expiresAt: this.#now() + 300_000 };
	}

	async listDrills(q: Resolved<ListDrillsInput>) {
		return structuredClone(this.#page(this.#drills.filter((d) => !q.destinationId || d.destinationId === q.destinationId), q.limit, q.before, (d) => d.id));
	}

	async runDrillNow(destinationId: string): Promise<RestoreDrillSummary> {
		this.#find(this.#destinations, destinationId, 'destination');
		const d: RestoreDrillSummary = { id: this.#id('drill'), destinationId, database: 'granary', runId: null, startedAt: this.#now(), finishedAt: null, result: null, detail: null, rpoMs: null, rtoMs: null };
		this.#drills.unshift(d);
		return structuredClone(d);
	}

	async listSinks() {
		return structuredClone(this.#sinks);
	}

	async saveSink(draft: TelemetrySinkDraft): Promise<TelemetrySinkConfig> {
		const now = this.#now();
		if (draft.id) {
			const s = this.#find(this.#sinks, draft.id, 'sink');
			if (draft.version !== s.version) throw new OpsBackendError('conflict', `sink ${s.id} changed`);
			Object.assign(s, { ...draft, version: s.version + 1, updatedAt: now, origin: 'ui' });
			return structuredClone(s);
		}
		const s: TelemetrySinkConfig = { id: this.#id('sink'), name: draft.name, enabled: false, origin: 'ui', version: 1, createdAt: now, updatedAt: now, kind: 'otlp-http', endpoint: draft.endpoint, auth: draft.auth, signals: draft.signals, volumeBudgetBytesPerMonth: draft.volumeBudgetBytesPerMonth, maxBufferBytes: 8 * MiB, flushIntervalMs: 2000, grafanaUrl: draft.grafanaUrl, lastTest: null };
		this.#sinks.push(s);
		return structuredClone(s);
	}

	async deleteSink(id: string) {
		this.#find(this.#sinks, id, 'sink');
		this.#sinks = this.#sinks.filter((s) => s.id !== id);
	}

	async testSink(input: TestSinkInput): Promise<TestConnectionResult> {
		const endpoint = input.draft?.endpoint ?? this.#find(this.#sinks, input.id ?? '', 'sink').endpoint;
		return { ok: true, at: this.#now(), resolvedEndpoint: `${endpoint}/v1/traces`, steps: [{ name: 'POST empty OTLP request', ok: true, skipped: false, durationMs: 38, detail: '200 OK', providerCode: null }], advisories: [] };
	}

	async getTelemetryStats(sinkId: string): Promise<TelemetryStats> {
		const s = this.#find(this.#sinks, sinkId, 'sink');
		return { sinkId, windowMs: DAY, sentBatches: 41_220, sentBytes: 212 * MiB, droppedBatches: 0, droppedBytes: 0, bufferedBytes: 18_000, sampleRatio: 1, volumeThisMonthBytes: Math.round(3.1 * GiB), volumeBudgetBytes: s.volumeBudgetBytesPerMonth, lastError: null };
	}

	async listSecrets() {
		return structuredClone(this.#secrets);
	}

	async setSecret(input: SetSecretInput): Promise<SecretMeta> {
		const now = this.#now();
		const fingerprint = `…${input.value.slice(-4)} · ${sha(input.value).slice(0, 6)}`;
		if (input.id) {
			const s = this.#find(this.#secrets, input.id, 'secret');
			Object.assign(s, { name: input.name, kind: input.kind, fingerprint, updatedAt: now, lastUsedAt: null, lastUsedOk: null });
			return structuredClone(s);
		}
		const s: SecretMeta = { id: this.#id('secret'), name: input.name, kind: input.kind, fingerprint, kekId: 'a1b2c3d4e5f60718', kekCurrent: true, createdAt: now, updatedAt: now, lastUsedAt: null, lastUsedOk: null, usedBy: [] };
		this.#secrets.push(s);
		return structuredClone(s);
	}

	async deleteSecret(id: string) {
		const s = this.#find(this.#secrets, id, 'secret');
		if (s.usedBy.length) throw new OpsBackendError('conflict', 'secret is still referenced');
		this.#secrets = this.#secrets.filter((x) => x.id !== id);
	}

	async getKeyStatus(): Promise<KeyStatus> {
		return { master: 'ok', kekId: 'a1b2c3d4e5f60718', previousKekPresent: false, secretsOnPreviousKek: 0, backupsOnMissingKek: 0 };
	}

	async getBudgets() {
		return structuredClone(this.#budgets);
	}

	async saveBudgets(b: Budgets) {
		if (b.version !== this.#budgets.version) throw new OpsBackendError('conflict', 'budgets changed');
		this.#budgets = { ...structuredClone(b), version: b.version + 1 };
		return structuredClone(this.#budgets);
	}

	async exportConfig(): Promise<ConfigExport> {
		return { format: 'granary-ops-config/1', exportedAt: this.#now(), destinations: structuredClone(this.#destinations), plans: structuredClone(this.#plans), sinks: structuredClone(this.#sinks), budgets: structuredClone(this.#budgets), secretRefs: this.#secrets.map(({ id, name, kind }) => ({ id, name, kind })) };
	}

	async importConfig(): Promise<ImportResult> {
		return { created: 0, updated: 0, skipped: 0, missingSecrets: [] };
	}

	async listOpsActors(): Promise<OpsActorSummary[]> {
		return [
			{ address: { family: 'ops-config', name: 'main' }, runtimeId: '1:1', activeStates: ['ready'], scheduling: 'idle' },
			{ address: { family: 'backup-plan', name: 'seed-all' }, runtimeId: '2:1', activeStates: ['armed'], scheduling: 'idle' },
			{ address: { family: 'upload', name: `${this.#runs[0]!.run.id}.seed-r2` }, runtimeId: '9:1', activeStates: ['uploading'], scheduling: 'idle' },
			{ address: { family: 'telemetry-sink', name: 'seed-otlp' }, runtimeId: '3:1', activeStates: ['idle'], scheduling: 'idle' },
			{ address: { family: 'restore-drill', name: 'seed-r2' }, runtimeId: '10:1', activeStates: ['idle'], scheduling: 'idle' },
			{ address: { family: 'restore-drill', name: 'seed-r2' }, runtimeId: '11:1', activeStates: ['fetching'], scheduling: 'idle' },
			{ address: { family: 'watchdog', name: 'main' }, runtimeId: '4:1', activeStates: ['sampling'], scheduling: 'idle' },
			{ address: { family: 'condition', name: 'outbox-dead' }, runtimeId: '5:1', activeStates: ['attention'], scheduling: 'idle' },
			{ address: { family: 'remediator', name: 'main' }, runtimeId: '6:1', activeStates: ['idle'], scheduling: 'idle' }
		];
	}
}

