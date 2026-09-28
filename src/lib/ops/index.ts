/**
 * Ops module entry point (ADR 0080). Only `src/lib/server/boot.ts` and
 * `src/hooks.server.ts` may import this file. M0: a no-op module (inactive); the real module is assembled in
 * later milestones (ADR 0105, 0109). Not wired into granary yet.
 */
import { OpsBackendError, type CreateOps, type OpsBackend, type OpsModule } from './contract';

/** Every OpsBackend method rejects with `unavailable` until the real backend exists. */
const unavailableBackend = new Proxy({} as OpsBackend, {
	get: (_t, method) =>
		typeof method === 'symbol' || method === 'then'
			? undefined
			: async () => {
					throw new OpsBackendError('unavailable', `ops backend method ${String(method)} not implemented yet (M0)`);
				}
});

export const createOps: CreateOps = (host) => {
	const backend = unavailableBackend;
	const module: OpsModule = {
		async start() {
			host.log.info('ops: M0 no-op module (inactive)');
		},
		async stop() {},
		status: () => ({
			at: Date.now(),
			mode: 'inactive',
			sleepOk: false,
			reasons: ['operations module not implemented yet (M0)'],
			attentionCount: 0,
			handledLast24h: 0,
			backups: [],
			lastDrill: null,
			telemetry: []
		}),
		telemetrySink: { write: () => {} },
		backend
	};
	return module;
};

export type { OpsHost, OpsModule } from './contract';

/** For `hooks.server.ts` only: UI development without the real module (GRANARY_STUB_OPS=1). */
export async function createStubOpsBackend(): Promise<OpsBackend> {
	const { StubOpsBackend } = await import('./backend.stub');
	return new StubOpsBackend();
}
