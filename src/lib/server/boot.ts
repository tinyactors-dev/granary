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
import { getRuntime, onShutdown, startRuntime } from './system';

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

export async function bootBackend(config: Config, opts: { devMode: boolean }): Promise<Backend> {
	const runtime = startRuntime(config, opts);
	if (opts.devMode) {
		startDapServer(runtime.system, config.dapPort);
		onShutdown(() => stopDapServer());
	}
	installShutdown();
	log.info('backend ready');
	return new RealBackend(runtime);
}
