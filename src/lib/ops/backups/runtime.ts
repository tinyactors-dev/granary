/**
 * Shared state of the backups feature (ADR 0111): the I/O processors,
 * loaders and backend all reach ops.sqlite, keys, the Worker and the System
 * through this object. It exists from `createBackupsFeature()`; `ctx` and the
 * chart definitions are bound in `start()`.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Definition, System } from '@tinyactors/node';
import type { OpsContext } from '../feature';
import type { HostDatabase } from '../schemas/host';
import type { Destination } from '../schemas/destinations';
import { OPS_FAMILY, drillAddress, planAddress, retentionAddress, type OpsAddress } from '../schemas/events';
import type { BackupPlan } from '../schemas/plans';
import { MAX_STRETCHED_INTERVAL_MS } from '../schemas/plans';
import { BackupsRepo } from './repo';
import { openStore, type BackupStore } from './stores';
import { SnapshotWorker } from './worker';
import type { SecretStore } from '../secrets/store';
import type { MasterKeys } from '../secrets/keys';

export interface BackupsOptions {
	/** First upload retry delay; doubles per attempt, capped at 30 min (ADR 0082). */
	retryBaseMs: number;
	maxUploadAttempts: number;
	/** Daily retention pass interval. */
	retentionIntervalMs: number;
	/** How long an upload waits for retention to make room before it proceeds anyway. */
	makeRoomTimeoutMs: number;
}

export const DEFAULT_BACKUPS_OPTIONS: BackupsOptions = {
	retryBaseMs: 30_000,
	maxUploadAttempts: 6,
	retentionIntervalMs: 24 * 3_600_000,
	makeRoomTimeoutMs: 10 * 60_000
};

export interface Definitions {
	config: Definition<any>;
	plan: Definition<any>;
	run: Definition<any>;
	upload: Definition<any>;
	retention: Definition<any>;
	drill: Definition<any>;
}

export class BackupsRuntime {
	ctx: OpsContext | null = null;
	repo: BackupsRepo | null = null;
	secrets: SecretStore | null = null;
	keys: MasterKeys | null = null;
	defs: Definitions | null = null;
	readonly worker = new SnapshotWorker();
	readonly options: BackupsOptions;

	constructor(options: Partial<BackupsOptions> = {}) {
		this.options = { ...DEFAULT_BACKUPS_OPTIONS, ...options };
	}

	get c(): OpsContext {
		if (!this.ctx) throw new Error('backups feature not started');
		return this.ctx;
	}
	get r(): BackupsRepo {
		if (!this.repo) throw new Error('backups feature not started');
		return this.repo;
	}
	get system(): System {
		return this.c.system;
	}
	get now(): number {
		return this.c.now();
	}
	get spoolDir(): string {
		return join(this.c.host.dataDir, 'ops-spool');
	}

	/** Databases to back up: granary's (OpsHost) plus ops.sqlite itself (ADR 0083). */
	databases(): HostDatabase[] {
		const list = [...this.c.host.databases];
		const opsPath = this.c.db.filename;
		if (opsPath && opsPath !== ':memory:' && !list.some((d) => d.id === 'ops')) list.push({ id: 'ops', label: 'ops (this module)', path: opsPath });
		return list;
	}

	database(id: string): HostDatabase | null {
		return this.databases().find((d) => d.id === id) ?? null;
	}

	/** Size of a live database including its WAL (the snapshot needs about that much). */
	dbBytes(path: string): number {
		let n = 0;
		for (const p of [path, `${path}-wal`]) if (existsSync(p)) n += statSync(p).size;
		return n;
	}

	/** Open a store for a destination; the credential is revealed now and not cached (ADR 0086). */
	async store(dest: Destination, purpose: string): Promise<BackupStore> {
		const secrets = this.secrets!;
		return openStore(dest.settings, { secret: (ref) => secrets.reveal(ref, purpose), dataDir: this.c.host.dataDir });
	}

	secretRefOf(dest: Destination): string | null {
		return dest.settings.kind === 'local-dir' ? null : dest.settings.secretAccessKey.secretRef;
	}

	egressKind(dest: Destination): string | null {
		return dest.settings.kind === 'r2' ? 'r2-upload' : dest.settings.kind === 's3' ? 's3-upload' : null;
	}

	post(address: OpsAddress, event: string, data?: unknown): void {
		this.c.post(address, event, data);
	}

	// ---- derived schedules (ADR 0089: never trust delayed sends across restarts) ----

	planBinding(p: BackupPlan) {
		return {
			planId: p.id,
			enabled: p.enabled,
			intervalMs: p.effectiveIntervalMs || p.intervalMs,
			lastStartedAt: this.r.lastStartedAt(p.id),
			trigger: 'schedule',
			requestedBy: null
		};
	}

	/** Drill schedule of a destination: the shortest drill interval of plans using it; their databases. */
	drillBinding(destinationId: string) {
		const plans = this.r.plans().filter((p) => p.destinationIds.includes(destinationId));
		const databases = [...new Set(plans.flatMap((p) => p.databases))].filter((d) => this.database(d));
		const intervalMs = plans.length ? Math.min(...plans.map((p) => p.drillIntervalMs)) : 7 * 86_400_000;
		return { destinationId, intervalMs, lastDrillAt: this.r.lastDrillAt(destinationId), databases, queue: [] as string[], drillId: null, database: null, localPath: null, runId: null, manifest: null, requestedBy: null };
	}

	retentionBinding(destinationId: string) {
		return { destinationId, dailyMs: this.options.retentionIntervalMs, waiters: [] as unknown[], current: null, mode: 'daily' };
	}

	/**
	 * Egress-aware interval (ADR 0098, 0107): if the projected monthly off-site
	 * upload volume exceeds the budget, stretch the interval (max 6 h).
	 */
	effectiveInterval(p: BackupPlan): { ms: number; stretched: boolean; projectedBytes: number; budgetBytes: number } {
		const budgetBytes = this.r.budgets().r2EgressBytesPerMonth;
		const offsite = p.destinationIds.map((id) => this.r.destination(id)).filter((d): d is Destination => !!d && d.enabled && d.settings.kind !== 'local-dir');
		if (!offsite.length) return { ms: p.intervalMs, stretched: false, projectedBytes: 0, budgetBytes };
		const perRunBytes = offsite.reduce((sum, d) => {
			const done = this.r.doneUploads(d.id, 20);
			const perDb = new Map<string, number[]>();
			for (const u of done) perDb.set(u.database, [...(perDb.get(u.database) ?? []), u.uploaded_bytes]);
			let s = 0;
			for (const db of p.databases) {
				const xs = perDb.get(db) ?? [];
				s += xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
			}
			return sum + s;
		}, 0);
		const projectedBytes = Math.round(perRunBytes * ((30 * 86_400_000) / p.intervalMs));
		if (projectedBytes <= budgetBytes) return { ms: p.intervalMs, stretched: false, projectedBytes, budgetBytes };
		const factor = Math.ceil(projectedBytes / budgetBytes);
		const ms = Math.max(p.intervalMs, Math.min(MAX_STRETCHED_INTERVAL_MS, p.intervalMs * factor));
		return { ms, stretched: ms > p.intervalMs, projectedBytes, budgetBytes };
	}

	/** Recompute and persist a plan's effective interval; record a `handled` item when it changes (ADR 0098, 0107). */
	refreshInterval(planId: string): { planId: string; effectiveIntervalMs: number; stretched: boolean } | null {
		const plan = this.r.plan(planId);
		if (!plan) return null;
		const eff = this.effectiveInterval(plan);
		if (eff.ms !== plan.effectiveIntervalMs) {
			this.r.setEffectiveInterval(plan.id, eff.ms);
			this.r.event(
				'handled',
				eff.stretched
					? `backup plan ${plan.name}: interval stretched to ${Math.round(eff.ms / 60_000)} min — projected upload egress ${eff.projectedBytes} B/month exceeds the ${eff.budgetBytes} B budget`
					: `backup plan ${plan.name}: interval back to ${Math.round(eff.ms / 60_000)} min (egress within budget)`,
				{ planId: plan.id, ...eff }
			);
		}
		return { planId: plan.id, effectiveIntervalMs: eff.ms, stretched: eff.stretched };
	}

	// ---- reconcile: long-lived actors follow the config rows (ADR 0082, 0111) ----

	#resident(a: OpsAddress) {
		return this.system.findActor(a);
	}

	#put(def: Definition<any>, address: OpsAddress, binding: object, replace: boolean, out: { spawned: string[]; replaced: string[] }) {
		const name = `${address.family}/${address.name}`;
		this.remember(address.family, address.name);
		const incumbent = this.#resident(address);
		if (!incumbent) {
			this.c.spawn(def, address, binding);
			out.spawned.push(name);
			return;
		}
		if (!replace) return;
		try {
			incumbent.prepareReplacement(def, { binding }).activate();
		} catch {
			// busy (inside a macrostep) or failed activation: destroy + spawn; its mail is re-sent by its peers.
			try {
				incumbent.destroy();
			} catch {
				/* already gone */
			}
			this.c.spawn(def, address, binding);
		}
		out.replaced.push(name);
	}

	reconcile(area: string | null, id: string | null): { spawned: string[]; replaced: string[]; destroyed: string[] } {
		const defs = this.defs!;
		const out = { spawned: [] as string[], replaced: [] as string[], destroyed: [] as string[] };
		const all = area === null || area === 'budgets';
		const plans = this.r.plans();
		const dests = this.r.destinations().filter((d) => d.enabled);
		const touches = (a: string, x: string) => all || (area === a && id === x) || (area === 'plan' && a === 'drill');
		for (const p of plans) this.#put(defs.plan, planAddress(p.id), this.planBinding(p), touches('plan', p.id), out);
		for (const d of dests) {
			this.#put(defs.retention, retentionAddress(d.id), this.retentionBinding(d.id), touches('destination', d.id), out);
			this.#put(defs.drill, drillAddress(d.id), this.drillBinding(d.id), touches('destination', d.id) || touches('drill', d.id), out);
		}
		// Stale long-lived actors (deleted/disabled rows).
		const want = new Set([...plans.map((p) => `${OPS_FAMILY.plan}/${p.id}`), ...dests.flatMap((d) => [`${OPS_FAMILY.retention}/${d.id}`, `${OPS_FAMILY.drill}/${d.id}`])]);
		for (const [family, names] of this.spawnedNames) {
			for (const name of [...names]) {
				const key = `${family}/${name}`;
				if (want.has(key)) continue;
				const a = this.system.findActor({ family, name });
				if (a) {
					try {
						a.destroy();
					} catch {
						/* gone */
					}
					out.destroyed.push(key);
				}
				names.delete(name);
			}
		}
		return out;
	}

	/** Long-lived actors this runtime put, per family (for stale cleanup). */
	readonly spawnedNames = new Map<string, Set<string>>();
	remember(family: string, name: string): void {
		const s = this.spawnedNames.get(family) ?? new Set<string>();
		s.add(name);
		this.spawnedNames.set(family, s);
	}
}
