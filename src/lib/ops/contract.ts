/**
 * THE seam between granary and the operations module (ADR 0080, 0109).
 *
 * Granary code may import only this file (and `boot.ts` may import
 * `$lib/ops/index`). Enforced by `mise run check:boundaries`.
 * Everything here is types, TypeBox schemas and a tiny backend registry.
 */
import type { Budgets } from './schemas/budgets';
import type { BackupPlan, BackupPlanDraft } from './schemas/plans';
import type { Condition, Banner, OpsEvent } from './schemas/conditions';
import type { Destination, DestinationDraft } from './schemas/destinations';
import type { HostDatabase, HostHealthSnapshot, TelemetryBatch } from './schemas/host';
import type { BackupRunDetail, BackupRunSummary, RestoreDrillSummary } from './schemas/runs';
import type { KeyStatus, SecretMeta, SetSecretInput } from './schemas/secrets';
import type { TelemetrySinkConfig, TelemetrySinkDraft } from './schemas/sinks';
import type { OpsStatus } from './schemas/status';
import type {
	ConfigExport,
	DownloadLink,
	ImportResult,
	ListDrillsInput,
	ListEventsInput,
	ListRunsInput,
	OpsActorSummary,
	Projections,
	Resolved,
	RetentionPreview,
	TelemetryStats,
	TestConnectionResult,
	TestDestinationInput,
	TestSinkInput
} from './schemas/api';
import type { Page } from './schemas/common';

export * from './schemas/common';
export * from './schemas/destinations';
export * from './schemas/plans';
export * from './schemas/sinks';
export * from './schemas/budgets';
export * from './schemas/secrets';
export * from './schemas/manifest';
export * from './schemas/runs';
export * from './schemas/conditions';
export * from './schemas/host';
export * from './schemas/status';
export * from './schemas/api';

// ---------------------------------------------------------------------------
// granary → ops
// ---------------------------------------------------------------------------

export interface OpsLogger {
	info(message: string, ...rest: unknown[]): void;
	warn(message: string, ...rest: unknown[]): void;
	error(message: string, ...rest: unknown[]): void;
}

/** granary's telemetry, as OTLP export requests. */
export interface TelemetrySource {
	subscribe(listener: (batch: TelemetryBatch) => void): () => void;
}

/** What granary gives ops. Ports only; ops never reaches into granary. */
export interface OpsHost {
	databases: HostDatabase[];
	/** Cheap, synchronous, never throws. */
	health(): HostHealthSnapshot;
	telemetry: TelemetrySource;
	log: OpsLogger;
	/** OPS_* seeds, OPS_MASTER_KEY(_PREVIOUS), OTEL_* legacy seed (see schemas/env.ts). */
	env: Record<string, string | undefined>;
	/** Where ops.sqlite, the spool and local copies live. */
	dataDir: string;
	/** granary's version string, recorded in manifests. */
	version: string;
	/** Dev mode: generated master key allowed (ADR 0086). */
	devMode: boolean;
}

// ---------------------------------------------------------------------------
// ops → granary
// ---------------------------------------------------------------------------

/** granary's Tracer writes here instead of POSTing itself. Never throws, never blocks. */
export interface TelemetrySink {
	write(batch: TelemetryBatch): void;
	/**
	 * False when no sink is enabled, so the writer can skip encoding work
	 * (additive, ADR 0121). Absent = assume true.
	 */
	active?(): boolean;
}

export interface OpsModule {
	start(): Promise<void>;
	stop(): Promise<void>;
	status(): OpsStatus;
	telemetrySink: TelemetrySink;
	backend: OpsBackend;
}

export type CreateOps = (host: OpsHost) => OpsModule;

// ---------------------------------------------------------------------------
// OpsBackend: the seam for remote functions / pages (ADR 0092, 0104)
// ---------------------------------------------------------------------------

/**
 * Conventions (same as granary's Backend, ADR 0032): epoch ms, inputs
 * already validated with `limit` resolved, expected failures throw
 * `OpsBackendError`. `actor` is the signed-in login performing a mutation.
 * No method ever returns a secret value.
 */
export interface OpsBackend {
	// overview & "while you were away"
	getStatus(): Promise<OpsStatus>;
	getBanner(login: string): Promise<Banner>;
	markVisited(login: string): Promise<void>;
	listConditions(): Promise<Condition[]>;
	acknowledgeCondition(id: string, actor: string): Promise<Condition>;
	listEvents(query: Resolved<ListEventsInput>): Promise<Page<OpsEvent>>;

	// destinations & retention
	listDestinations(): Promise<Destination[]>;
	saveDestination(draft: DestinationDraft, actor: string): Promise<Destination>;
	deleteDestination(id: string, actor: string): Promise<void>;
	testDestination(input: TestDestinationInput, actor: string): Promise<TestConnectionResult>;
	previewRetention(destinationId: string): Promise<RetentionPreview>;
	getProjections(destinationId: string): Promise<Projections>;

	// plans, runs, drills
	listPlans(): Promise<BackupPlan[]>;
	savePlan(draft: BackupPlanDraft, actor: string): Promise<BackupPlan>;
	deletePlan(id: string, actor: string): Promise<void>;
	runBackupNow(planId: string, actor: string): Promise<BackupRunSummary[]>;
	listRuns(query: Resolved<ListRunsInput>): Promise<Page<BackupRunSummary>>;
	getRun(runId: string): Promise<BackupRunDetail | null>;
	getDownloadLink(runId: string, destinationId: string, actor: string): Promise<DownloadLink>;
	listDrills(query: Resolved<ListDrillsInput>): Promise<Page<RestoreDrillSummary>>;
	runDrillNow(destinationId: string, actor: string): Promise<RestoreDrillSummary>;

	// telemetry
	listSinks(): Promise<TelemetrySinkConfig[]>;
	saveSink(draft: TelemetrySinkDraft, actor: string): Promise<TelemetrySinkConfig>;
	deleteSink(id: string, actor: string): Promise<void>;
	testSink(input: TestSinkInput, actor: string): Promise<TestConnectionResult>;
	getTelemetryStats(sinkId: string): Promise<TelemetryStats>;

	// secrets & keys (write-only values)
	listSecrets(): Promise<SecretMeta[]>;
	setSecret(input: SetSecretInput, actor: string): Promise<SecretMeta>;
	deleteSecret(id: string, actor: string): Promise<void>;
	getKeyStatus(): Promise<KeyStatus>;

	// budgets, config import/export, ops actors
	getBudgets(): Promise<Budgets>;
	saveBudgets(budgets: Budgets, actor: string): Promise<Budgets>;
	exportConfig(): Promise<ConfigExport>;
	importConfig(config: ConfigExport, actor: string): Promise<ImportResult>;
	listOpsActors(): Promise<OpsActorSummary[]>;
}

/** Method groups for parallel implementation (ADR 0109): the real backend composes them. */
export type OpsBackendBackups = Pick<
	OpsBackend,
	| 'listDestinations' | 'saveDestination' | 'deleteDestination' | 'testDestination' | 'previewRetention' | 'getProjections'
	| 'listPlans' | 'savePlan' | 'deletePlan' | 'runBackupNow' | 'listRuns' | 'getRun' | 'getDownloadLink' | 'listDrills' | 'runDrillNow'
	| 'listSecrets' | 'setSecret' | 'deleteSecret' | 'getKeyStatus' | 'getBudgets' | 'saveBudgets' | 'exportConfig' | 'importConfig'
>;
export type OpsBackendHealth = Pick<
	OpsBackend,
	| 'getStatus' | 'getBanner' | 'markVisited' | 'listConditions' | 'acknowledgeCondition' | 'listEvents'
	| 'listSinks' | 'saveSink' | 'deleteSink' | 'testSink' | 'getTelemetryStats' | 'listOpsActors'
>;

export type OpsBackendErrorCode = 'not-found' | 'conflict' | 'invalid' | 'unavailable' | 'upstream' | 'degraded';

export class OpsBackendError extends Error {
	readonly code: OpsBackendErrorCode;
	constructor(code: OpsBackendErrorCode, message: string) {
		super(message);
		this.name = 'OpsBackendError';
		this.code = code;
	}
}
export const isOpsBackendError = (e: unknown): e is OpsBackendError => e instanceof OpsBackendError;
export const opsBackendErrorStatus = (code: OpsBackendErrorCode): number =>
	({ 'not-found': 404, conflict: 409, invalid: 400, unavailable: 503, upstream: 502, degraded: 503 })[code];

const REGISTRY = Symbol.for('granary.opsBackend');
type Registry = { [REGISTRY]?: OpsBackend | null };

export function setOpsBackend(backend: OpsBackend | null): void {
	(globalThis as Registry)[REGISTRY] = backend;
}
export function hasOpsBackend(): boolean {
	return !!(globalThis as Registry)[REGISTRY];
}
export function getOpsBackend(): OpsBackend {
	const b = (globalThis as Registry)[REGISTRY];
	if (!b) throw new OpsBackendError('unavailable', 'ops backend not registered (ops not started; see ADR 0109)');
	return b;
}
