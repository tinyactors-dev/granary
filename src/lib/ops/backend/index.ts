/**
 * OpsBackend composition (ADR 0109, 0110, 0120): the health half and the
 * backups half are separate objects; methods of a feature that isn't
 * composed (yet) reject with `unavailable` instead of crashing the page.
 */
import { OpsBackendError, type ConfigExport, type ImportResult, type OpsBackend, type OpsBackendBackups, type OpsBackendHealth } from '../contract';

export const HEALTH_METHODS = [
	'getStatus', 'getBanner', 'markVisited', 'listConditions', 'acknowledgeCondition', 'listEvents',
	'listSinks', 'saveSink', 'deleteSink', 'testSink', 'getTelemetryStats', 'listOpsActors'
] as const satisfies readonly (keyof OpsBackendHealth)[];

export const BACKUP_METHODS = [
	'listDestinations', 'saveDestination', 'deleteDestination', 'testDestination', 'previewRetention', 'getProjections',
	'listPlans', 'savePlan', 'deletePlan', 'runBackupNow', 'listRuns', 'getRun', 'getDownloadLink', 'listDrills', 'runDrillNow',
	'listSecrets', 'setSecret', 'deleteSecret', 'getKeyStatus', 'getBudgets', 'saveBudgets', 'exportConfig', 'importConfig'
] as const satisfies readonly (keyof OpsBackendBackups)[];

function bindAll<T extends object>(target: T | undefined, methods: readonly string[], feature: string, out: Record<string, unknown>) {
	for (const m of methods) {
		const fn = target ? (target as Record<string, unknown>)[m] : undefined;
		out[m] =
			typeof fn === 'function'
				? (fn as (...a: unknown[]) => unknown).bind(target)
				: async () => {
						throw new OpsBackendError('unavailable', `ops ${feature} feature is not running (${m})`);
					};
	}
}

/** Health-side sink import, used by the composed importConfig (ADR 0150). */
export interface SinkImporter {
	importSinks(raw: unknown[], actor: string): { created: number; skipped: number; missingSecrets: string[] };
}

export function composeBackend(parts: { health?: OpsBackendHealth & Partial<SinkImporter>; backups?: OpsBackendBackups }): OpsBackend {
	const out: Record<string, unknown> = {};
	bindAll(parts.health, HEALTH_METHODS, 'health', out);
	bindAll(parts.backups, BACKUP_METHODS, 'backups', out);
	// Config import spans both halves: backups imports destinations/plans/budgets,
	// health imports sinks (ADR 0150).
	const health = parts.health;
	const backups = parts.backups;
	if (backups && health?.importSinks) {
		out.importConfig = async (config: ConfigExport, actor: string): Promise<ImportResult> => {
			const res = await backups.importConfig({ ...config, sinks: [] }, actor);
			const sinks = health.importSinks!(config.sinks ?? [], actor);
			return {
				created: res.created + sinks.created,
				updated: res.updated,
				skipped: res.skipped + sinks.skipped,
				missingSecrets: [...new Set([...res.missingSecrets, ...sinks.missingSecrets])]
			};
		};
	}
	return out as unknown as OpsBackend;
}

/** A backend whose every method rejects with `unavailable` (ops not started or failed to start). */
export function unavailableBackend(reason: string): OpsBackend {
	return new Proxy({} as OpsBackend, {
		get: (_t, method) =>
			typeof method === 'symbol' || method === 'then'
				? undefined
				: async () => {
						throw new OpsBackendError('unavailable', `${reason} (${String(method)})`);
					}
	});
}
