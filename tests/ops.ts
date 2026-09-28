/**
 * Ops scenario helpers (ADR 0150): a client for the app's dev-only
 * `/__dev/api/ops` JSON surface and a typed client for fake-infra's
 * `/__control` API. Responses are checked against the pinned schemas.
 */
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { CONTROL_PATHS, FakeInfraState, InjectFaultResponse, type FidelityRequest, type InjectFaultRequest } from '../fake-infra/schemas';
import { OpsStatus } from '../src/lib/ops/schemas/status';
import type { BackupRunDetail, BackupRunSummary, RestoreDrillSummary } from '../src/lib/ops/schemas/runs';
import type { Condition, OpsEvent } from '../src/lib/ops/schemas/conditions';
import type { TelemetryStats } from '../src/lib/ops/schemas/api';
import type { Harness } from './harness';

function checked<T>(schema: TSchema, value: unknown, what: string): T {
	if (!Value.Check(schema, value)) {
		const first = [...Value.Errors(schema, value)].slice(0, 3).map((e) => `${e.path}: ${e.message}`);
		throw new Error(`${what} does not match its schema: ${first.join('; ')}`);
	}
	return value as T;
}

async function asJson(res: Response, what: string): Promise<unknown> {
	const text = await res.text();
	if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}

export class OpsClient {
	constructor(private readonly h: Harness) {}

	private async get(path: string): Promise<unknown> {
		return asJson(await this.h.fetchApp(`/__dev/api/ops/${path}`), `GET ops/${path}`);
	}
	private async post(path: string, body: unknown): Promise<unknown> {
		return asJson(
			await this.h.fetchApp(`/__dev/api/ops/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
			`POST ops/${path}`
		);
	}

	async status(): Promise<OpsStatus> {
		return checked<OpsStatus>(OpsStatus, await this.get('status'), 'ops status');
	}
	async runs(limit = 100): Promise<BackupRunSummary[]> {
		return ((await this.get(`runs?limit=${limit}`)) as { items: BackupRunSummary[] }).items;
	}
	async run(id: string): Promise<BackupRunDetail | null> {
		return (await this.get(`runs/${id}`)) as BackupRunDetail | null;
	}
	async drills(limit = 100): Promise<RestoreDrillSummary[]> {
		return ((await this.get(`drills?limit=${limit}`)) as { items: RestoreDrillSummary[] }).items;
	}
	async conditions(): Promise<Condition[]> {
		return (await this.get('conditions')) as Condition[];
	}
	async events(limit = 200): Promise<OpsEvent[]> {
		return ((await this.get(`events?limit=${limit}`)) as { items: OpsEvent[] }).items;
	}
	async plans(): Promise<{ id: string; intervalMs: number; effectiveIntervalMs: number; databases: string[] }[]> {
		return (await this.get('plans')) as { id: string; intervalMs: number; effectiveIntervalMs: number; databases: string[] }[];
	}
	async sinkStats(sinkId: string): Promise<TelemetryStats> {
		return (await this.get(`sinks/${sinkId}/stats`)) as TelemetryStats;
	}
	async backupNow(planId = 'seed-all'): Promise<BackupRunSummary[]> {
		return (await this.post('backup-now', { planId })) as BackupRunSummary[];
	}
	async drillNow(destinationId: string): Promise<RestoreDrillSummary> {
		return (await this.post('drill-now', { destinationId })) as RestoreDrillSummary;
	}
	async condition(id: string): Promise<Condition | undefined> {
		return (await this.conditions()).find((c) => c.id === id);
	}
}

export class FakeInfraClient {
	constructor(readonly baseUrl: string) {}

	private async call(method: string, path: string, body?: unknown): Promise<unknown> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		return asJson(res, `${method} fake-infra ${path}`);
	}

	async state(): Promise<FakeInfraState> {
		return checked<FakeInfraState>(FakeInfraState, await this.call('GET', CONTROL_PATHS.state), 'fake-infra state');
	}
	async fault(req: InjectFaultRequest): Promise<string> {
		return checked<{ id: string }>(InjectFaultResponse, await this.call('POST', CONTROL_PATHS.faults, req), 'fault').id;
	}
	async clearFaults(): Promise<void> {
		await this.call('DELETE', CONTROL_PATHS.faults);
	}
	async fidelity(toggles: Partial<FidelityRequest>): Promise<void> {
		await this.call('PUT', CONTROL_PATHS.fidelity, toggles);
	}
	/** Objects in the seeded bucket. */
	async objects(bucket = 'granary-backups') {
		return (await this.state()).buckets.find((b) => b.name === bucket)?.objects ?? [];
	}
	/** Plant objects directly (bodies as UTF-8 text), e.g. synthetic aged backups (ADR 0103). */
	async seedObjects(objects: { key: string; bytes: number; lastModified: number; body?: string }[], bucket = 'granary-backups'): Promise<void> {
		await this.call('POST', CONTROL_PATHS.objects, { bucket, objects });
	}
}

const ARTIFACT_SUFFIX = '.sqlite.zst.aesgcm';
const MANIFEST_SUFFIX = `${ARTIFACT_SUFFIX}.manifest.json`;

/** Manifest keys in a listing, by run id (ADR 0113: `<artifact>.manifest.json`). */
export function manifestsByRun(objects: { key: string }[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const o of objects) {
		if (!o.key.endsWith(MANIFEST_SUFFIX)) continue;
		const runId = o.key.slice(o.key.lastIndexOf('/') + 1, -MANIFEST_SUFFIX.length);
		out.set(runId, [...(out.get(runId) ?? []), o.key]);
	}
	return out;
}

/** Data objects (artifacts) in a listing. */
export const artifactsOf = <T extends { key: string }>(objects: T[]): T[] => objects.filter((o) => o.key.endsWith(ARTIFACT_SUFFIX));

/** Spans the ops System exported (service.name granary-ops, ADR 0120). */
export const OPS_SERVICE = 'granary-ops';
