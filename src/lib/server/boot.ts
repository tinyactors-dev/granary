/**
 * Boot the real backend (ADR 0003, ADR 0040): runtime (DB → system →
 * allowlist → issue loader → relay → re-post pending inbox), DAP server in
 * dev mode, graceful shutdown hooks. Called from `hooks.server.ts` `init`,
 * which finishes before the server accepts HTTP.
 */
import type { Config } from '$lib/schemas/config';
import type { Backend } from './backend';
import { RealBackend } from './backend.real';
import { startDapServer, stopDapServer } from './dap';
import { log } from './log';
import { attachLogExport } from './log-export';
import { getRuntime, onShutdown, startRuntime, type Runtime } from './system';
import { resolve } from 'node:path';
import { createOps } from '$lib/ops/index';
import { hasOpsBackend, setOpsBackend, type OpsModule } from '$lib/ops/contract';
import { createHostHealth } from './ops-health';
import { AdminStore } from './admins';
import { startAdminSocket, stopAdminSocket } from './admin-socket';
import { closeGranarySecrets, openGranarySecrets } from './secrets';
import { markNotReady, markReady } from './readiness';
import { DATA_DIR_LAYOUT } from '$lib/schemas/cli';
import { VERSION } from '$lib/version';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIGNALS_KEY = Symbol.for('granary.signals');
type G = { [SIGNALS_KEY]?: boolean };

function installShutdown(): void {
	const g = globalThis as G;
	if (g[SIGNALS_KEY]) return;
	g[SIGNALS_KEY] = true;
	const stop = (reason: string) => {
		const rt = getRuntime();
		if (!rt || rt.closed) return;
		void rt.shutdown(reason).finally(() => {
			// If something still holds the event loop (e.g. under vite), exit shortly.
			setTimeout(() => process.exit(0), 2000).unref?.();
		});
	};
	// svelte-adapter-bun emits this on SIGINT/SIGTERM before stopping its server.
	process.on('sveltekit:shutdown' as 'SIGTERM', () => stop('sveltekit:shutdown'));
	process.once('SIGTERM', () => stop('SIGTERM'));
	process.once('SIGINT', () => stop('SIGINT'));
}

const OPS_KEY = Symbol.for('granary.ops');
type OpsG = { [OPS_KEY]?: OpsModule };

/**
 * Start the operations module (ADR 0080, 0120) after the runtime is up: it
 * gets an OpsHost (database paths, health, logger, env), granary's Tracer
 * exports through its telemetry sink, and its OpsBackend is registered for
 * the /ops pages. A failing ops module never stops granary: the Tracer then
 * keeps POSTing to OTEL_EXPORTER_OTLP_ENDPOINT itself, as before.
 */
async function startOps(runtime: Runtime, config: Config, opts: { devMode: boolean }): Promise<void> {
	const g = globalThis as OpsG;
	if (g[OPS_KEY]) return;
	const dbPath = resolve(config.databasePath);
	const hostHealth = createHostHealth(runtime);
	const ops = createOps({
		databases: [{ id: 'granary', label: 'granary', path: dbPath }],
		health: () => hostHealth.health(),
		telemetry: { subscribe: () => () => {} }, // reserved: granary pushes via ops.telemetrySink instead (ADR 0121)
		log,
		env: process.env,
		dataDir: resolve(config.dataDir),
		version: VERSION,
		devMode: opts.devMode
	});
	try {
		await ops.start();
	} catch (e) {
		log.error('ops module failed to start; granary continues without it (telemetry falls back to direct export)', e);
		hostHealth.stop();
		await ops.stop().catch(() => undefined);
		return;
	}
	g[OPS_KEY] = ops;
	runtime.tracer.attachSink(ops.telemetrySink);
	const detachLogs = attachLogExport(ops.telemetrySink);
	if (!hasOpsBackend()) setOpsBackend(ops.backend);
	onShutdown(async () => {
		detachLogs();
		hostHealth.stop();
		await ops.stop();
		if (g[OPS_KEY] === ops) delete g[OPS_KEY];
	});
}

/** Admin seeds (GRANARY_ADMINS / ADMINS); never removes admins (ADR 0161). */
function seedAdmins(admins: AdminStore, config: Config): string[] {
	const added = admins.seedAdmins(config.admins);
	for (const l of added) log.info(`admins: seeded ${l}`);
	return added.map((l) => `admin:${l}`);
}

/** `<data>/granary.pid` (advisory; the CLI uses it to decide offline mode, ADR 0159). */
function writePidFile(dataDir: string): void {
	const file = join(dataDir, DATA_DIR_LAYOUT.pidFile);
	try {
		writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
		onShutdown(() => {
			try {
				if (existsSync(file) && readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file);
			} catch {
				/* ignore */
			}
		});
	} catch (e) {
		log.warn(`could not write ${file}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export async function bootBackend(config: Config, opts: { devMode: boolean }): Promise<Backend> {
	const runtime = startRuntime(config, opts);
	const dataDir = resolve(config.dataDir);
	const admins = new AdminStore(runtime.wal.db);
	seedAdmins(admins, config);
	try {
		const { keys } = await openGranarySecrets({ db: runtime.wal.db, env: process.env, dataDir, devMode: opts.devMode, log });
		if (keys.status === 'missing') log.warn('no master key (GRANARY_MASTER_KEY or <data>/master.key): secrets, the GitHub App and backups are disabled; webhooks still land in the inbox (ADR 0157)');
	} catch (e) {
		log.error('master key could not be loaded; secrets are disabled', e);
	}
	onShutdown(() => closeGranarySecrets());
	await startOps(runtime, config, opts);
	if (opts.devMode) {
		startDapServer(runtime.system, config.dapPort);
		onShutdown(() => stopDapServer());
	}
	installShutdown();
	const backend = new RealBackend(runtime);
	writePidFile(dataDir);
	startAdminSocket({
		backend,
		admins: backend.adminStore,
		dataDir,
		origin: backend.origin,
		databasePath: resolve(config.databasePath),
		seed: () => seedAdmins(backend.adminStore, config),
		systemCheck: () =>
			runtime.closed
				? { name: 'system', status: 'fail', detail: 'the actor system is shut down' }
				: { name: 'system', status: 'ok', detail: `granary ${VERSION}, pid ${process.pid}` }
	});
	onShutdown(() => {
		markNotReady();
		stopAdminSocket();
	});
	markReady();
	log.info('backend ready');
	return backend;
}
