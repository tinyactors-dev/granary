/**
 * Ops module entry point (ADR 0080, 0110, 0120). Only `src/lib/server/boot.ts`
 * and `src/hooks.server.ts` may import this file.
 *
 * `createOps(host)` assembles the ops System from its features:
 *   - health (telemetry fan-out and sinks, watchdog, conditions, remediator)
 *   - backups (destinations, plans, runs, uploads, drills, secrets)
 * Failures inside ops never take granary down: `start()` rejects, the caller
 * logs it and keeps going.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { OpsBackendError, type CreateOps, type OpsBackend, type OpsModule, type OpsStatus, type TelemetryBatch } from './contract';
import type { BackupsFeature, OpsContext, OpsFeature, SecretReader } from './feature';
import { openOpsDb } from './db/open';
import { createOpsSystem, type OpsSystem } from './system';
import { createHealthFeature } from './features/health';
import { composeBackend, unavailableBackend } from './backend/index';
import { backupsFeature } from './features/backups';

/**
 * The backups feature (ADR 0111–0118), composed through the
 * OpsFeature seam (ADR 0120). Remove it here to run ops without backups: its
 * OpsBackend methods then reject `unavailable` and secrets can't be revealed.
 */
function optionalBackupsFeature(env: Record<string, string | undefined>): BackupsFeature | null {
	return backupsFeature(env);
}

const INACTIVE: OpsStatus = {
	at: 0,
	mode: 'inactive',
	sleepOk: false,
	reasons: ['operations module not started'],
	attentionCount: 0,
	handledLast24h: 0,
	backups: [],
	lastDrill: null,
	telemetry: []
};

/** Secrets can't be revealed without the backups feature (it owns the store). */
const noSecrets: SecretReader = {
	async reveal(ref) {
		throw new OpsBackendError('unavailable', `secret store not available (backups feature not running); cannot reveal ${ref}`);
	},
	recordUse() {}
};

export const createOps: CreateOps = (host) => {
	/** Features other than health that failed to start (ops keeps running without them). */
	const failed = new Map<string, string>();
	// Remediations contributed by other features, only while they run (ADR 0123).
	const health = createHealthFeature({ remediations: () => (backups && !failed.has(backups.name) ? (backups.remediations ?? {}) : {}) });
	const backups = optionalBackupsFeature(host.env);
	const features: OpsFeature<unknown>[] = [health, ...(backups ? [backups] : [])];

	let db: Database | null = null;
	let ops: OpsSystem | null = null;
	let backend: OpsBackend = unavailableBackend('ops not started yet');
	let sink: { write(b: TelemetryBatch): void; active?(): boolean } | null = null;
	let started = false;
	let stopped = false;

	const delegate = new Proxy({} as OpsBackend, {
		get: (_t, method) => (typeof method === 'symbol' || method === 'then' ? undefined : (backend as unknown as Record<string, unknown>)[method as string])
	});

	const module: OpsModule = {
		async start() {
			if (started) return;
			started = true;
			mkdirSync(host.dataDir, { recursive: true });
			const dbPath = join(host.dataDir, 'ops.sqlite');
			db = openOpsDb(dbPath);
			const now = () => Date.now();
			const redactor = health.redactor();
			let secrets: SecretReader = noSecrets;
			if (backups) {
				try {
					secrets = backups.secrets({ host, db, now, redactor });
				} catch (e) {
					failed.set(backups.name, e instanceof Error ? e.message : String(e));
				}
			}

			const fanoutWants = () => {
				try {
					return (health.runtime()?.fanout.wantsOps() ?? false) && !stopped;
				} catch {
					return false;
				}
			};
			ops = createOpsSystem({
				io: Object.assign({}, ...features.map((f) => f.io)),
				log: host.log,
				exportTraces: (b) => health.runtime()?.fanout.write(b),
				wantsTraces: fanoutWants
			});
			const sys = ops;
			const ctx: OpsContext = {
				host,
				db,
				system: sys.system,
				now,
				secrets,
				redactor,
				post(target, event, data) {
					try {
						sys.post(target, event, data);
					} catch (e) {
						host.log.warn(`ops: could not post ${event} to ${target.family}/${target.name}`, e instanceof Error ? e.message : e);
					}
				},
				spawn: (definition, address, binding) => sys.spawn(definition, address, binding),
				excludeFromTraces: (d) => sys.excludeFromTraces(d),
				addresses: () => sys.known()
			};
			for (const f of features)
				for (const [family, l] of Object.entries(f.loaders ?? {}))
					sys.system.setLoader(
						family,
						(address) => {
							sys.note(address);
							return l.load(ctx, address);
						},
						l.options
					);
			// Health must start; any other feature that fails is left out (ADR 0120).
			for (const f of features) {
				if (failed.has(f.name)) continue;
				if (f === health) {
					await f.start(ctx);
					continue;
				}
				try {
					await f.start(ctx);
				} catch (e) {
					const why = e instanceof Error ? e.message : String(e);
					failed.set(f.name, why);
					host.log.error(`ops: the ${f.name} feature failed to start and is disabled until restart: ${why}`);
					await f.stop().catch(() => undefined);
				}
			}
			const backupsOk = !!backups && !failed.has(backups.name);
			// Seed sinks whose token secret the backups feature just seeded (ADR 0150).
			if (backupsOk) {
				try {
					health.runtime()?.reseedSinks();
				} catch (e) {
					host.log.warn('ops: re-seeding telemetry sinks failed', e instanceof Error ? e.message : e);
				}
			}
			backend = composeBackend({ health: health.backend(ctx), ...(backupsOk ? { backups: backups!.backend(ctx) } : {}) });
			sink = health.telemetrySink(ctx);
			host.log.info(
				`ops: started (${features.filter((f) => !failed.has(f.name)).map((f) => f.name).join(', ')}${failed.size ? `; failed: ${[...failed.keys()].join(', ')}` : ''}; db=${dbPath})`
			);
		},

		async stop() {
			if (stopped) return;
			stopped = true;
			backend = unavailableBackend('ops stopped');
			sink = null;
			for (const f of [...features].reverse().filter((x) => !failed.has(x.name))) {
				try {
					await f.stop();
				} catch (e) {
					host.log.error(`ops: stopping ${f.name} failed`, e);
				}
			}
			ops?.close();
			try {
				db?.close();
			} catch (e) {
				host.log.error('ops: closing ops.sqlite failed', e);
			}
		},

		status() {
			const rt = health.runtime();
			if (!rt || stopped) return { ...INACTIVE, at: Date.now() };
			try {
				const st = rt.status();
				if (!failed.size) return st;
				const reasons = [...failed].map(([name, why]) => `The ${name} feature failed to start: ${why}`);
				return { ...st, mode: 'degraded', sleepOk: false, reasons: [...reasons, ...st.reasons] };
			} catch (e) {
				return { ...INACTIVE, at: Date.now(), mode: 'degraded', reasons: [`status unavailable: ${e instanceof Error ? e.message : String(e)}`] };
			}
		},

		telemetrySink: {
			write(batch) {
				sink?.write(batch);
			},
			active() {
				return !!sink && (sink.active?.() ?? true);
			}
		},

		backend: delegate
	};
	return module;
};

export type { OpsHost, OpsModule } from './contract';

/** For `hooks.server.ts` only: UI development without the real module (GRANARY_STUB_OPS=1). */
export async function createStubOpsBackend(): Promise<OpsBackend> {
	const { StubOpsBackend } = await import('./backend.stub');
	return new StubOpsBackend();
}
