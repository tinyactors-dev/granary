/**
 * OpsBackendBackups (ADR 0092, 0104, 0110, 0114): destinations, plans, runs,
 * drills, secrets, budgets, config import/export. Every mutation commits to
 * ops.sqlite first, then posts `config.changed` to `ops-config/main`
 * (ADR 0102). No method returns a secret value.
 */
import { OpsBackendError, type OpsBackendBackups } from '../contract';
import type { OpsContext } from '../feature';
import type { ConfigExport, ImportResult, Projections, RetentionPreview, TestConnectionResult, TestDestinationInput } from '../schemas/api';
import type { Budgets } from '../schemas/budgets';
import type { Destination, DestinationDraft } from '../schemas/destinations';
import type { BackupPlan, BackupPlanDraft } from '../schemas/plans';
import type { BackupRunDetail, BackupRunSummary, RestoreDrillSummary } from '../schemas/runs';
import type { SecretMeta, SetSecretInput } from '../schemas/secrets';
import { OPS_CONFIG_ADDRESS, drillAddress, planAddress } from '../schemas/events';
import { newId, type DestinationConfig } from '../backups/repo';
import type { BackupsRuntime } from '../backups/runtime';
import { planRetention, steadyStateCount } from '../backups/retention-plan';
import { testDestination as runTest } from '../backups/test-connection';
import { fmt } from '../backups/disk';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > until) return null;
		await sleep(50);
	}
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function backupsBackend(rt: BackupsRuntime, ctx: OpsContext): OpsBackendBackups {
	const r = () => rt.r;
	const changed = (area: 'destination' | 'plan' | 'budgets' | 'secret', id: string) => ctx.post(OPS_CONFIG_ADDRESS, 'config.changed', { area, id });
	const secrets = () => {
		if (!rt.secrets) throw new OpsBackendError('unavailable', 'backups feature not started');
		return rt.secrets;
	};

	function validateSettings(draft: DestinationDraft) {
		const s = draft.settings;
		if (s.kind !== 'local-dir' && !secrets().exists(s.secretAccessKey.secretRef)) {
			throw new OpsBackendError('invalid', `secret ${s.secretAccessKey.secretRef} does not exist — store the secret access key first (setSecret)`);
		}
		if (s.kind !== 'local-dir' && s.prefix && !s.prefix.endsWith('/')) throw new OpsBackendError('invalid', 'prefix must be empty or end with "/"');
	}

	const configOf = (d: DestinationDraft): DestinationConfig => ({ settings: d.settings, retention: d.retention, caps: d.caps, ...(d.consoleUrl ? { consoleUrl: d.consoleUrl } : {}) });

	const recomputeInterval = (planId: string) => rt.refreshInterval(planId);

	return {
		// ---- destinations -----------------------------------------------------
		async listDestinations(): Promise<Destination[]> {
			return r().destinations();
		},

		async saveDestination(draft: DestinationDraft, actor: string): Promise<Destination> {
			validateSettings(draft);
			const existing = draft.id ? r().destination(draft.id) : null;
			if (existing) {
				if (draft.version !== existing.version) throw new OpsBackendError('conflict', `destination ${existing.id} changed (now version ${existing.version})`);
				const config = configOf(draft);
				const unchanged = sameJson(config.settings, existing.settings);
				const testedNow = !!existing.lastTest?.ok && existing.lastTest.versionTested === existing.version;
				const enabling = draft.enabled && !existing.enabled;
				if (enabling && !(testedNow && unchanged)) throw new OpsBackendError('invalid', 'run a successful test connection with these settings before enabling');
				r().tx(() => {
					r().updateDestination(existing.id, existing.version, { name: draft.name, enabled: draft.enabled, config, keepTest: unchanged && testedNow });
					r().audit(actor, 'destination.update', 'destination', existing.id, { enabled: draft.enabled, settingsChanged: !unchanged });
				});
				changed('destination', existing.id);
				return r().requireDestination(existing.id);
			}
			const id = draft.id ?? newId('dest', rt.now);
			r().tx(() => {
				// New destinations start disabled until a test connection passed (ADR 0102).
				r().insertDestination({ id, name: draft.name, enabled: false, origin: 'ui', config: configOf(draft) });
				r().audit(actor, 'destination.create', 'destination', id, { kind: draft.settings.kind });
			});
			changed('destination', id);
			return r().requireDestination(id);
		},

		async deleteDestination(id: string, actor: string): Promise<void> {
			r().requireDestination(id);
			const users = r().plans().filter((p) => p.destinationIds.includes(id));
			if (users.length) throw new OpsBackendError('conflict', `destination ${id} is used by plan(s) ${users.map((p) => p.id).join(', ')}`);
			r().tx(() => {
				r().deleteDestination(id);
				r().audit(actor, 'destination.delete', 'destination', id);
			});
			changed('destination', id);
		},

		async testDestination(input: TestDestinationInput, actor: string): Promise<TestConnectionResult> {
			const stored = input.id ? r().requireDestination(input.id) : null;
			const settings = input.draft?.settings ?? stored?.settings;
			if (!settings) throw new OpsBackendError('invalid', 'give an existing destination id or a draft');
			const egressKind = settings.kind === 'r2' ? 'r2-upload' : settings.kind === 's3' ? 's3-upload' : null;
			const result = await secrets().withCandidates(input.candidateSecrets, () =>
				runTest({
					settings,
					secret: (ref) => secrets().reveal(ref, `test-connection:${input.id ?? 'draft'}`),
					dataDir: ctx.host.dataDir,
					now: () => rt.now,
					onEgress: (n) => egressKind && r().addEgress(egressKind, n)
				})
			);
			// Record only when the stored settings (and stored secrets) were tested.
			const candidates = input.candidateSecrets && Object.keys(input.candidateSecrets).length > 0;
			if (stored && !candidates && (!input.draft || sameJson(input.draft.settings, stored.settings))) {
				r().recordDestinationTest(stored.id, stored.version, result.ok);
			}
			if (settings.kind !== 'local-dir' && !candidates) secrets().recordUse(settings.secretAccessKey.secretRef, result.ok);
			r().audit(actor, 'destination.test', 'destination', input.id ?? null, { ok: result.ok, endpoint: result.resolvedEndpoint });
			return result;
		},

		async previewRetention(destinationId: string): Promise<RetentionPreview> {
			const d = r().requireDestination(destinationId);
			const store = await rt.store(d, `preview-retention:${d.id}`);
			const local = d.settings.kind === 'local-dir';
			const plan = planRetention({
				objects: await store.list(store.prefix),
				prefix: store.prefix,
				now: rt.now,
				schedule: local ? { ...d.retention, floor: 1 } : d.retention,
				caps: local ? { ...d.caps, maxBackupsPerDatabase: 1 } : d.caps
			});
			return {
				destinationId,
				at: rt.now,
				keep: plan.keep,
				delete: plan.delete.map((x) => ({ key: x.key, database: x.database, createdAt: x.createdAt, bytes: x.bytes, reason: x.reason })),
				unknownObjects: plan.unknownObjects,
				totalBytesAfter: plan.totalBytesAfter,
				backupsAfterPerDatabase: plan.backupsAfterPerDatabase,
				floorExceedsCap: plan.floorExceedsCap
			};
		},

		async getProjections(destinationId: string): Promise<Projections> {
			const d = r().requireDestination(destinationId);
			const plans = r().plans().filter((p) => p.destinationIds.includes(destinationId));
			const dbs = [...new Set(plans.flatMap((p) => p.databases))];
			const interval = plans.length ? Math.min(...plans.map((p) => p.effectiveIntervalMs || p.intervalMs)) : 3_600_000;
			const configured = plans.length ? Math.min(...plans.map((p) => p.intervalMs)) : 3_600_000;
			const done = r().doneUploads(destinationId, 200);
			const recent = done.slice(0, 20);
			const averageSealedBytes = recent.length ? Math.round(recent.reduce((s, u) => s + u.uploaded_bytes, 0) / recent.length) : 0;
			const local = d.settings.kind === 'local-dir';
			const perDb = local ? 1 : steadyStateCount(d.retention, d.caps, interval);
			const steadyStateBackups = perDb * Math.max(1, dbs.length);
			const steadyStateBytes = Math.min(d.caps.maxBytes, steadyStateBackups * averageSealedBytes);
			// Growth: linear trend of sealed sizes over the last 14 days (bytes/day).
			const since = rt.now - 14 * 86_400_000;
			const pts = done.filter((u) => u.started_at >= since).map((u) => [(u.started_at - since) / 86_400_000, u.uploaded_bytes] as const);
			let monthsUntilCap: number | null = null;
			if (pts.length >= 3 && averageSealedBytes > 0) {
				const n = pts.length;
				const mx = pts.reduce((s, p) => s + p[0], 0) / n;
				const my = pts.reduce((s, p) => s + p[1], 0) / n;
				const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / Math.max(1e-9, pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0));
				const headroomPerBackup = d.caps.maxBytes / steadyStateBackups - averageSealedBytes;
				if (slope > 0 && headroomPerBackup > 0) monthsUntilCap = Math.round((headroomPerBackup / slope / 30) * 10) / 10;
				else if (headroomPerBackup <= 0) monthsUntilCap = 0;
			}
			const explanation = averageSealedBytes
				? `${steadyStateBackups} backups × ${fmt(averageSealedBytes)} ≈ ${fmt(steadyStateBackups * averageSealedBytes)} of ${fmt(d.caps.maxBytes)}` +
					(monthsUntilCap === null ? '' : monthsUntilCap === 0 ? '; already at the cap — the oldest monthly backups are dropped first' : `; at the current growth the cap is reached in ~${monthsUntilCap} months, then the oldest monthly backups are dropped first`)
				: 'no committed backups yet — projections appear after the first upload';
			let egress: Projections['egress'] = null;
			if (!local) {
				const budgetBytes = r().budgets().r2EgressBytesPerMonth;
				const usedThisMonthBytes = r().egressThisMonth([d.settings.kind === 'r2' ? 'r2-upload' : 's3-upload']);
				const projectedMonthBytes = Math.round(averageSealedBytes * Math.max(1, dbs.length) * ((30 * 86_400_000) / interval));
				egress = {
					usedThisMonthBytes,
					projectedMonthBytes,
					budgetBytes,
					configuredIntervalMs: configured,
					effectiveIntervalMs: interval,
					stretched: interval > configured,
					explanation:
						interval > configured
							? `interval stretched from ${Math.round(configured / 60_000)} to ${Math.round(interval / 60_000)} min to keep upload egress (${fmt(projectedMonthBytes)}/month) within ${fmt(budgetBytes)}`
							: `${fmt(projectedMonthBytes)}/month projected of ${fmt(budgetBytes)} (uploads leave exe.dev and are billed; downloads are free)`
				};
			}
			return {
				destinationId,
				storage: { steadyStateBackups, averageSealedBytes, steadyStateBytes, capBytes: d.caps.maxBytes, capBackupsPerDatabase: local ? 1 : d.caps.maxBackupsPerDatabase, monthsUntilCap, explanation },
				egress
			};
		},

		// ---- plans, runs, drills ---------------------------------------------
		async listPlans(): Promise<BackupPlan[]> {
			return r().plans();
		},

		async savePlan(draft: BackupPlanDraft, actor: string): Promise<BackupPlan> {
			for (const id of draft.destinationIds) r().requireDestination(id);
			for (const db of draft.databases) if (!rt.database(db)) throw new OpsBackendError('invalid', `unknown database ${db} (known: ${rt.databases().map((d) => d.id).join(', ')})`);
			const config = { databases: draft.databases, destinationIds: draft.destinationIds, intervalMs: draft.intervalMs, drillIntervalMs: draft.drillIntervalMs };
			const existing = draft.id ? r().plan(draft.id) : null;
			let id: string;
			if (existing) {
				if (draft.version !== existing.version) throw new OpsBackendError('conflict', `plan ${existing.id} changed (now version ${existing.version})`);
				id = existing.id;
				r().tx(() => {
					r().updatePlan(id, existing.version, { name: draft.name, enabled: draft.enabled, config });
					r().audit(actor, 'plan.update', 'plan', id, config);
				});
			} else {
				id = draft.id ?? newId('plan', rt.now);
				r().tx(() => {
					r().insertPlan({ id, name: draft.name, enabled: draft.enabled, origin: 'ui', config });
					r().audit(actor, 'plan.create', 'plan', id, config);
				});
			}
			recomputeInterval(id);
			changed('plan', id);
			return r().requirePlan(id);
		},

		async deletePlan(id: string, actor: string): Promise<void> {
			r().requirePlan(id);
			r().tx(() => {
				r().deletePlan(id);
				r().audit(actor, 'plan.delete', 'plan', id);
			});
			changed('plan', id);
		},

		async runBackupNow(planId: string, actor: string): Promise<BackupRunSummary[]> {
			r().requirePlan(planId);
			const t0 = rt.now;
			const lastEvent = (r().db.query('SELECT max(id) AS id FROM ops_events').get() as { id: number | null }).id ?? 0;
			ctx.post(planAddress(planId), 'plan.run-now', { requestedBy: actor });
			const rows = await waitFor(() => {
				const xs = r().db.query("SELECT * FROM backup_runs WHERE plan_id = ? AND trigger = 'manual' AND started_at >= ? ORDER BY started_at DESC").all(planId, t0) as never[];
				return xs.length ? xs : null;
			}, 5_000);
			if (!rows) {
				const refusal = r().db.query("SELECT message FROM ops_events WHERE id > ? AND message LIKE ? ORDER BY id DESC LIMIT 1").get(lastEvent, `backup plan ${planId}:%`) as { message: string } | null;
				throw new OpsBackendError('unavailable', refusal?.message ?? `plan ${planId} did not start a run (it may be busy dispatching)`);
			}
			return (rows as Parameters<typeof rt.r.runSummary>[0][]).map((x) => r().runSummary(x));
		},

		async listRuns(q) {
			return r().listRuns(q);
		},

		async getRun(runId: string): Promise<BackupRunDetail | null> {
			const row = r().runRow(runId);
			if (!row) return null;
			const ups = r().uploadRows(runId);
			const withManifest = ups.find((u) => u.state === 'done' && u.manifest) ?? ups.find((u) => u.manifest);
			return { run: r().runSummary(row), uploads: ups.map((u) => r().uploadSummary(u)), manifest: withManifest ? r().uploadManifest(withManifest) : null };
		},

		async getDownloadLink(runId: string, destinationId: string, actor: string) {
			const u = r().uploadRow(runId, destinationId);
			if (!u || u.state !== 'done' || !u.artifact_key) throw new OpsBackendError('not-found', 'no committed backup for that run/destination');
			const d = r().requireDestination(destinationId);
			const store = await rt.store(d, `download-link:${runId}`);
			const url = store.presignGet(u.artifact_key, 900);
			if (!url) throw new OpsBackendError('invalid', 'local copies have no download link; use `mise run ops:restore`');
			r().audit(actor, 'backup.download-link', 'run', runId, { destinationId });
			return { url, expiresAt: rt.now + 900_000 };
		},

		async listDrills(q) {
			return r().listDrills(q);
		},

		async runDrillNow(destinationId: string, actor: string): Promise<RestoreDrillSummary> {
			r().requireDestination(destinationId);
			const t0 = rt.now;
			ctx.post(drillAddress(destinationId), 'drill.run-now', { requestedBy: actor });
			const row = await waitFor(() => r().db.query('SELECT * FROM restore_drills WHERE destination_id = ? AND started_at >= ? ORDER BY started_at LIMIT 1').get(destinationId, t0) as never, 5_000);
			if (!row) throw new OpsBackendError('unavailable', `no drill started for ${destinationId} (is it enabled and used by a plan?)`);
			r().audit(actor, 'drill.run-now', 'destination', destinationId);
			return r().drillSummary(row);
		},

		// ---- secrets ---------------------------------------------------------
		async listSecrets(): Promise<SecretMeta[]> {
			return secrets().list();
		},
		async setSecret(input: SetSecretInput, actor: string): Promise<SecretMeta> {
			const m = await secrets().set(input, actor);
			changed('secret', m.id);
			return m;
		},
		async deleteSecret(id: string, actor: string): Promise<void> {
			secrets().delete(id, actor);
		},
		async getKeyStatus() {
			const known = new Set([rt.keys?.current?.id, rt.keys?.previous?.id].filter(Boolean));
			const missing = r().doneManifestKekIds().filter((k) => !known.has(k)).length;
			return secrets().keyStatus(missing);
		},

		// ---- budgets & config ------------------------------------------------
		async getBudgets(): Promise<Budgets> {
			return r().budgets();
		},
		async saveBudgets(b: Budgets, actor: string): Promise<Budgets> {
			const next = r().tx(() => {
				const n = r().saveBudgets(b);
				r().audit(actor, 'budgets.update', 'budgets', null, n);
				return n;
			});
			for (const p of r().plans()) recomputeInterval(p.id);
			changed('budgets', 'main');
			return next;
		},

		async exportConfig(): Promise<ConfigExport> {
			const sinks = (r().db.query('SELECT id, name, enabled, origin, version, config FROM telemetry_sinks ORDER BY id').all() as { id: string; name: string; enabled: number; origin: string; version: number; config: string }[]).map((s) => ({ ...s, enabled: s.enabled === 1, config: JSON.parse(s.config) }));
			return {
				format: 'granary-ops-config/1',
				exportedAt: rt.now,
				destinations: r().destinations(),
				plans: r().plans(),
				sinks,
				budgets: r().budgets(),
				secretRefs: secrets().list().map(({ id, name, kind }) => ({ id, name, kind }))
			};
		},

		async importConfig(config: ConfigExport, actor: string): Promise<ImportResult> {
			const out: ImportResult = { created: 0, updated: 0, skipped: 0, missingSecrets: [] };
			const missing = new Set<string>();
			for (const raw of config.destinations as Destination[]) {
				if (r().destination(raw.id)) {
					out.skipped++;
					continue;
				}
				if (raw.settings.kind !== 'local-dir' && !secrets().exists(raw.settings.secretAccessKey.secretRef)) missing.add(raw.settings.secretAccessKey.secretRef);
				r().insertDestination({ id: raw.id, name: raw.name, enabled: false, origin: 'ui', config: { settings: raw.settings, retention: raw.retention, caps: raw.caps } });
				out.created++;
			}
			for (const raw of config.plans as BackupPlan[]) {
				if (r().plan(raw.id)) {
					out.skipped++;
					continue;
				}
				r().insertPlan({ id: raw.id, name: raw.name, enabled: raw.enabled, origin: 'ui', config: { databases: raw.databases, destinationIds: raw.destinationIds, intervalMs: raw.intervalMs, drillIntervalMs: raw.drillIntervalMs } });
				out.created++;
			}
			// Telemetry sinks belong to the health feature; not imported here.
			out.skipped += config.sinks.length;
			out.missingSecrets = [...missing];
			r().audit(actor, 'config.import', 'config', null, out);
			ctx.post(OPS_CONFIG_ADDRESS, 'config.changed', { area: 'plan', id: '*' });
			return out;
		}
	};
}
