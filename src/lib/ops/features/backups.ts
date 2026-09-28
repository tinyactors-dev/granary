/**
 * The backups feature (milestones M1 + M2; ADR 0105, 0110, 0111–0114).
 *
 * Delivers, through the OpsFeature seam: I/O processors `snapshot`,
 * `object-store`, `backup-ledger`; loaders for the virtual families
 * `backup-run` and `upload`; the long-lived actors `ops-config/main`,
 * `backup-plan/*`, `retention/*`, `restore-drill/*`; the secret store
 * (`SecretReader`); seeds; and `OpsBackendBackups`.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActorAddress, LoadResult } from '@tinyactors/node';
import type { OpsBackendBackups } from '../contract';
import type { BackupsFeature, OpsContext, SecretReader } from '../feature';
import { OPS_CONFIG_ADDRESS, OPS_FAMILY, OPS_IO, parseUploadName, runAddress } from '../schemas/events';
import { TERMINAL_RUN_STATES, type RunState } from '../schemas/runs';
import { opsConfigChart } from '../actors/ops-config';
import { backupPlanChart } from '../actors/backup-plan';
import { backupRunChart } from '../actors/backup-run';
import { uploadChart } from '../actors/upload';
import { retentionChart } from '../actors/retention';
import { restoreDrillChart } from '../actors/restore-drill';
import { snapshotProcessor } from '../io/snapshot';
import { objectStoreProcessor } from '../io/object-store';
import { backupLedgerProcessor } from '../io/backup-ledger';
import { backupsBackend } from '../backend/backups';
import { BackupsRepo, newId } from '../backups/repo';
import { BackupsRuntime, type BackupsOptions } from '../backups/runtime';
import { loadMasterKeys, type MasterKeys } from '../../platform/secrets/keys';
import { SecretStore } from '../secrets/store';
import { runSeeds } from '../seeds';
import { backupsRemediations } from '../backups/remediations';

export interface BackupsFeatureHandle extends BackupsFeature {
	/** For tests/CLI/inspection; not part of the OpsFeature seam. */
	readonly runtime: BackupsRuntime;
}

/** Options from env (ADR 0111): shorter retry/retention timings in tests. */
export function backupsOptionsFromEnv(env: Record<string, string | undefined>): Partial<BackupsOptions> {
	const n = (k: string) => (env[k] && /^\d+$/.test(env[k]!) ? Number(env[k]) : undefined);
	const o: Partial<BackupsOptions> = {};
	const retry = n('GRANARY_TEST_RETRY_BASE_MS');
	if (retry !== undefined) o.retryBaseMs = retry;
	const retention = n('GRANARY_TEST_RETENTION_INTERVAL_MS');
	if (retention !== undefined) o.retentionIntervalMs = retention;
	return o;
}

export function createBackupsFeature(options: Partial<BackupsOptions> = {}): BackupsFeatureHandle {
	const rt = new BackupsRuntime(options);
	let keysPromise: Promise<MasterKeys> | null = null;
	let storePromise: Promise<SecretStore> | null = null;

	function secretStore(ctx: Omit<OpsContext, 'secrets' | 'system' | 'post' | 'spawn'>): Promise<SecretStore> {
		keysPromise ??= loadMasterKeys({ env: ctx.host.env, dataDir: ctx.host.dataDir, devMode: ctx.host.devMode, log: ctx.host.log });
		storePromise ??= keysPromise.then((keys) => {
			rt.keys = keys;
			rt.secrets = new SecretStore({ db: ctx.db, keys, redactor: ctx.redactor, now: ctx.now, newId: (p) => newId(p, ctx.now()) });
			return rt.secrets;
		});
		return storePromise;
	}

	const runLoader = (ctx: OpsContext, address: ActorAddress): LoadResult => {
		const repo = rt.r;
		const row = repo.runRow(address.name);
		if (!row || (TERMINAL_RUN_STATES as string[]).includes(row.state)) return 'not-found';
		const db = rt.database(row.database);
		const ups = repo.uploadRows(row.id);
		const plan = repo.plan(row.plan_id);
		const destinationIds = ups.length ? ups.map((u) => u.destination_id) : (plan?.destinationIds ?? []).filter((id) => repo.destination(id)?.enabled);
		const uploads: Record<string, 'done' | 'failed'> = {};
		for (const u of ups) if (u.state === 'done' || u.state === 'failed') uploads[u.destination_id] = u.state;
		return {
			spawn: rt.defs!.run,
			binding: {
				runId: row.id,
				planId: row.plan_id,
				database: row.database,
				dbPath: db?.path ?? '',
				spoolDir: rt.spoolDir,
				destinationIds,
				trigger: row.trigger,
				phase: row.state,
				snapshot: repo.runSnapshot(row),
				uploads,
				attempt: row.attempt,
				sealedBytes: row.sealed_bytes,
				outcome: null,
				error: row.error
			}
		};
	};

	const uploadLoader = (ctx: OpsContext, address: ActorAddress): LoadResult => {
		const repo = rt.r;
		const ids = parseUploadName(address.name);
		if (!ids) return 'not-found';
		const u = repo.uploadRow(ids.runId, ids.destinationId);
		const run = repo.runRow(ids.runId);
		if (!u || !run || u.state === 'done' || u.state === 'failed') return 'not-found';
		const dest = repo.destination(ids.destinationId);
		const lastSealed = repo.doneUploads(ids.destinationId, 1)[0]?.uploaded_bytes ?? 0;
		const snapshot = repo.runSnapshot(run);
		return {
			spawn: rt.defs!.upload,
			binding: {
				runId: ids.runId,
				destinationId: ids.destinationId,
				database: run.database,
				local: dest?.settings.kind === 'local-dir',
				phase: u.state,
				snapshot,
				artifactKey: u.artifact_key,
				manifest: repo.uploadManifest(u),
				attempts: u.attempts,
				maxAttempts: rt.options.maxUploadAttempts,
				retryBaseMs: rt.options.retryBaseMs,
				makeRoomTimeoutMs: rt.options.makeRoomTimeoutMs,
				nextAttemptAt: u.next_attempt_at,
				lastError: repo.uploadSummary(u).lastError,
				estimatedBytes: lastSealed ? Math.round(lastSealed * 1.1) : (snapshot?.rawBytes ?? 0)
			}
		};
	};

	/** Spool hygiene at boot (ADR 0089): drop files not owned by a non-terminal run. */
	async function cleanSpool(): Promise<number> {
		const keep = new Set(rt.r.nonTerminalRunPaths());
		let removed = 0;
		let names: string[] = [];
		try {
			names = await readdir(rt.spoolDir);
		} catch {
			return 0;
		}
		for (const name of names) {
			const p = join(rt.spoolDir, name);
			if (name === 'drills') {
				await rm(p, { recursive: true, force: true });
				removed++;
			} else if (!keep.has(p)) {
				await rm(p, { force: true, recursive: true });
				removed++;
			}
		}
		return removed;
	}

	const feature: BackupsFeatureHandle = {
		name: 'backups',
		runtime: rt,
		remediations: backupsRemediations(rt),
		io: {
			[OPS_IO.snapshot]: snapshotProcessor(rt),
			[OPS_IO.objectStore]: objectStoreProcessor(rt),
			[OPS_IO.ledger]: backupLedgerProcessor(rt)
		},
		loaders: {
			[OPS_FAMILY.run]: { load: runLoader },
			[OPS_FAMILY.upload]: { load: uploadLoader }
		},

		secrets(ctx): SecretReader {
			const ready = secretStore(ctx);
			return {
				reveal: async (ref, purpose) => (await ready).reveal(ref, purpose),
				recordUse: (ref, ok) => void ready.then((s) => s.recordUse(ref, ok))
			};
		},

		async start(ctx: OpsContext) {
			rt.ctx = ctx;
			rt.repo = new BackupsRepo(ctx.db, ctx.now);
			const store = await secretStore(ctx);
			const keys = rt.keys!;
			if (keys.status === 'missing') ctx.host.log.warn('ops/backups: GRANARY_MASTER_KEY is missing — backups will not run (ADR 0097)');
			const rewrap = await store.rewrapAndExpire();
			if (rewrap.rewrapped) rt.r.event('handled', `re-wrapped ${rewrap.rewrapped} secret(s) under the current master key`, rewrap);
			if (rewrap.unreadable) ctx.host.log.warn(`ops/backups: ${rewrap.unreadable} secret(s) are wrapped by a master key that is not configured`);
			const cleaned = await cleanSpool();
			if (cleaned) ctx.host.log.info(`ops/backups: removed ${cleaned} stale spool file(s)`);

			const sys = ctx.system;
			rt.defs = {
				config: sys.define(opsConfigChart()),
				plan: sys.define(backupPlanChart()),
				run: sys.define(backupRunChart()),
				upload: sys.define(uploadChart()),
				retention: sys.define(retentionChart()),
				drill: sys.define(restoreDrillChart())
			};

			const seeded = await runSeeds({ env: ctx.host.env, repo: rt.r, secrets: store, databases: rt.databases().map((d) => d.id) });
			if (seeded.created.length) ctx.host.log.info(`ops/backups: seeded ${seeded.created.join(', ')}`);

			if (!sys.findActor(OPS_CONFIG_ADDRESS)) ctx.spawn(rt.defs.config, OPS_CONFIG_ADDRESS);
			const r = rt.reconcile(null, null);
			ctx.host.log.info(`ops/backups: ${r.spawned.length} actor(s) started`);

			// Resume unfinished runs (ADR 0082 crash table): mail loads them from their rows.
			for (const row of rt.r.nonTerminalRuns()) {
				const ups = rt.r.uploadRows(row.id);
				const plan = rt.r.plan(row.plan_id);
				ctx.post(runAddress(row.id), 'run.start', {
					runId: row.id,
					planId: row.plan_id,
					database: row.database,
					destinationIds: ups.length ? ups.map((u) => u.destination_id) : (plan?.destinationIds ?? []),
					trigger: row.trigger as 'schedule' | 'catch-up' | 'manual'
				});
				ctx.host.log.info(`ops/backups: resuming run ${row.id} (${row.state as RunState})`);
			}
		},

		async stop() {
			rt.worker.terminate();
		},

		backend(ctx: OpsContext): OpsBackendBackups {
			return backupsBackend(rt, ctx);
		}
	};
	return feature;
}

/** Assembly helper for `index.ts` (ADR 0120 seam): env-derived options. */
export const backupsFeature = (env: Record<string, string | undefined> = {}): BackupsFeatureHandle => createBackupsFeature(backupsOptionsFromEnv(env));
