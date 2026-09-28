/**
 * Remote functions for the /ops pages (ADR 0092, 0104, 0140).
 *
 * Thin: validate with TypeBox (`standard()`), authorize, delegate to
 * `getOpsBackend()` from `$lib/ops/contract` — the only ops import allowed
 * here (ADR 0080). Reads need a signed-in user; mutations need an admin.
 * Secret values only ever travel browser → server (write-only, ADR 0086):
 * no function returns one.
 */
import { command, form, query, requested } from '$app/server';
import { error, invalid } from '@sveltejs/kit';
import { Type } from '@sinclair/typebox';
import { standard } from '$lib/schemas/standard';
import { currentUser, requireAdmin, requireUser } from '$lib/server/auth';
import {
	BackupPlanDraft,
	Budgets,
	ConfigExport,
	ConditionId,
	DestinationDraft,
	ListDrillsInput,
	ListEventsInput,
	ListRunsInput,
	OpsId,
	SecretKind,
	SetSecretInput,
	TelemetrySinkDraft,
	TestDestinationInput,
	TestSinkInput,
	getOpsBackend,
	hasOpsBackend,
	isOpsBackendError,
	opsBackendErrorStatus,
	type Banner,
	type BackupPlan,
	type BackupRunDetail,
	type BackupRunSummary,
	type Condition,
	type Destination,
	type DownloadLink,
	type ImportResult,
	type KeyStatus,
	type OpsActorSummary,
	type OpsBackend,
	type OpsEvent,
	type OpsStatus,
	type Page,
	type Projections,
	type RestoreDrillSummary,
	type RetentionPreview,
	type SecretMeta,
	type TelemetrySinkConfig,
	type TelemetryStats,
	type TestConnectionResult
} from '$lib/ops/contract';

const DEFAULT_LIMIT = 50;

/**
 * Placeholder secret ref for a typed-but-unsaved secret (ADR 0141). Must equal
 * `NEW_SECRET_REF` in `$lib/components/ops/secret-ref.ts`; duplicated because
 * the boundary rule's `/ops/` pattern also matches `$lib/components/ops/…`.
 */
const NEW_SECRET_REF = 'new-secret';

/** Run `fn(getOpsBackend())`, mapping `OpsBackendError` to an HTTP error with its message. */
async function withOps<T>(fn: (backend: OpsBackend) => Promise<T>): Promise<T> {
	try {
		return await fn(getOpsBackend());
	} catch (e) {
		if (isOpsBackendError(e)) error(opsBackendErrorStatus(e.code), e.message);
		throw e;
	}
}


const NewSecret = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 80 }),
		kind: SecretKind,
		value: Type.String({ minLength: 1, maxLength: 8192 })
	},
	{ additionalProperties: false }
);

/** Replace every `{secretRef: NEW_SECRET_REF}` in `obj` (deep) with `ref`. */
function substituteRef<T>(obj: T, ref: string): T {
	if (Array.isArray(obj)) return obj.map((x) => substituteRef(x, ref)) as T;
	if (obj && typeof obj === 'object') {
		const o = obj as Record<string, unknown>;
		if (Object.keys(o).length === 1 && o.secretRef === NEW_SECRET_REF) return { secretRef: ref } as T;
		return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, substituteRef(v, ref)])) as T;
	}
	return obj;
}

function usesNewSecret(obj: unknown): boolean {
	return JSON.stringify(obj).includes(`"secretRef":"${NEW_SECRET_REF}"`);
}

/** Store `secret` if the draft references NEW_SECRET_REF, and return the draft with the real ref. */
async function resolveNewSecret<T>(b: OpsBackend, draft: T, secret: { name: string; kind: SecretMeta['kind']; value: string } | undefined, actor: string): Promise<T> {
	if (!usesNewSecret(draft)) return draft;
	if (!secret) error(400, 'Enter the secret value, or pick a stored secret');
	const meta = await b.setSecret({ name: secret.name, kind: secret.kind, value: secret.value }, actor);
	return substituteRef(draft, meta.id);
}

// ---------------------------------------------------------------------------
// Overview, conditions, events, banner
// ---------------------------------------------------------------------------

export const getOpsStatus = query(async (): Promise<OpsStatus> => {
	requireUser();
	return withOps((b) => b.getStatus());
});

/**
 * The global "while you were away" banner (ADR 0100/0104). Never fails a page:
 * null when nobody is signed in or the ops module isn't running.
 */
export const getOpsBanner = query(async (): Promise<Banner | null> => {
	const user = currentUser();
	if (!user || !hasOpsBackend()) return null;
	try {
		return await getOpsBackend().getBanner(user.login);
	} catch {
		return null;
	}
});

/** Dismiss the banner's "handled since your last visit" part (any signed-in user). */
export const markOpsVisited = command(async (): Promise<void> => {
	const user = requireUser();
	await withOps((b) => b.markVisited(user.login));
	await getOpsBanner().refresh();
});

export const listOpsConditions = query(async (): Promise<Condition[]> => {
	requireUser();
	return withOps((b) => b.listConditions());
});

export const acknowledgeOpsCondition = command(
	standard(Type.Object({ id: ConditionId }, { additionalProperties: false })),
	async ({ id }): Promise<Condition> => {
		const admin = requireAdmin();
		const c = await withOps((b) => b.acknowledgeCondition(id, admin.login));
		await Promise.all([listOpsConditions().refresh(), getOpsStatus().refresh(), getOpsBanner().refresh()]);
		return c;
	}
);

export const listOpsEvents = query(standard(ListEventsInput), async (input): Promise<Page<OpsEvent>> => {
	requireUser();
	return withOps((b) => b.listEvents({ ...input, limit: input.limit ?? DEFAULT_LIMIT }));
});

// ---------------------------------------------------------------------------
// Destinations, retention, projections
// ---------------------------------------------------------------------------

export const listOpsDestinations = query(async (): Promise<Destination[]> => {
	requireUser();
	return withOps((b) => b.listDestinations());
});

const IdInput = Type.Object({ id: OpsId }, { additionalProperties: false });

export const getOpsRetentionPreview = query(standard(IdInput), async ({ id }): Promise<RetentionPreview> => {
	requireUser();
	return withOps((b) => b.previewRetention(id));
});

export const getOpsProjections = query(standard(IdInput), async ({ id }): Promise<Projections> => {
	requireUser();
	return withOps((b) => b.getProjections(id));
});

/**
 * Save a destination. When `draft` references `NEW_SECRET_REF`, `secret`
 * (the typed value) is stored first and the draft points at the new secret.
 */
export const saveOpsDestination = command(
	standard(Type.Object({ draft: DestinationDraft, secret: Type.Optional(NewSecret) }, { additionalProperties: false })),
	async ({ draft, secret }): Promise<Destination> => {
		const admin = requireAdmin();
		const saved = await withOps(async (b) => b.saveDestination(await resolveNewSecret(b, draft, secret, admin.login), admin.login));
		await Promise.all([listOpsDestinations().refresh(), listOpsSecrets().refresh()]);
		return saved;
	}
);

export const deleteOpsDestination = command(standard(IdInput), async ({ id }): Promise<void> => {
	const admin = requireAdmin();
	await withOps((b) => b.deleteDestination(id, admin.login));
	await listOpsDestinations().refresh();
});

/**
 * Test connection for a stored destination or an unsaved draft. A typed but
 * unsaved secret goes in `candidateSecrets` under `NEW_SECRET_REF` and is
 * used for this test only (ADR 0086).
 */
export const testOpsDestination = command(standard(TestDestinationInput), async (input): Promise<TestConnectionResult> => {
	const admin = requireAdmin();
	const result = await withOps((b) => b.testDestination(input, admin.login));
	if (input.id) await listOpsDestinations().refresh();
	return result;
});

// ---------------------------------------------------------------------------
// Plans, runs, drills
// ---------------------------------------------------------------------------

export const listOpsPlans = query(async (): Promise<BackupPlan[]> => {
	requireUser();
	return withOps((b) => b.listPlans());
});

export const saveOpsPlan = command(standard(BackupPlanDraft), async (draft): Promise<BackupPlan> => {
	const admin = requireAdmin();
	const plan = await withOps((b) => b.savePlan(draft, admin.login));
	await listOpsPlans().refresh();
	return plan;
});

export const deleteOpsPlan = command(standard(IdInput), async ({ id }): Promise<void> => {
	const admin = requireAdmin();
	await withOps((b) => b.deletePlan(id, admin.login));
	await listOpsPlans().refresh();
});

export const runOpsBackupNow = command(standard(IdInput), async ({ id }): Promise<BackupRunSummary[]> => {
	const admin = requireAdmin();
	const runs = await withOps((b) => b.runBackupNow(id, admin.login));
	// Refresh the run lists the client asked for via `.updates(...)`.
	await requested(listOpsRuns, 10).refreshAll();
	return runs;
});

export const listOpsRuns = query(standard(ListRunsInput), async (input): Promise<Page<BackupRunSummary>> => {
	requireUser();
	return withOps((b) => b.listRuns({ ...input, limit: input.limit ?? DEFAULT_LIMIT }));
});

export const getOpsRun = query(standard(IdInput), async ({ id }): Promise<BackupRunDetail | null> => {
	requireUser();
	return withOps((b) => b.getRun(id));
});

/** Presigned, short-lived download URL for one committed backup (admin). */
export const getOpsDownloadLink = command(
	standard(Type.Object({ runId: OpsId, destinationId: OpsId }, { additionalProperties: false })),
	async ({ runId, destinationId }): Promise<DownloadLink> => {
		const admin = requireAdmin();
		return withOps((b) => b.getDownloadLink(runId, destinationId, admin.login));
	}
);

export const listOpsDrills = query(standard(ListDrillsInput), async (input): Promise<Page<RestoreDrillSummary>> => {
	requireUser();
	return withOps((b) => b.listDrills({ ...input, limit: input.limit ?? DEFAULT_LIMIT }));
});

export const runOpsDrillNow = command(standard(IdInput), async ({ id }): Promise<RestoreDrillSummary> => {
	const admin = requireAdmin();
	const drill = await withOps((b) => b.runDrillNow(id, admin.login));
	await requested(listOpsDrills, 10).refreshAll();
	return drill;
});

// ---------------------------------------------------------------------------
// Telemetry sinks
// ---------------------------------------------------------------------------

export const listOpsSinks = query(async (): Promise<TelemetrySinkConfig[]> => {
	requireUser();
	return withOps((b) => b.listSinks());
});

export const getOpsSinkStats = query(standard(IdInput), async ({ id }): Promise<TelemetryStats> => {
	requireUser();
	return withOps((b) => b.getTelemetryStats(id));
});

export const saveOpsSink = command(
	standard(Type.Object({ draft: TelemetrySinkDraft, secret: Type.Optional(NewSecret) }, { additionalProperties: false })),
	async ({ draft, secret }): Promise<TelemetrySinkConfig> => {
		const admin = requireAdmin();
		const saved = await withOps(async (b) => b.saveSink(await resolveNewSecret(b, draft, secret, admin.login), admin.login));
		await Promise.all([listOpsSinks().refresh(), listOpsSecrets().refresh()]);
		return saved;
	}
);

export const deleteOpsSink = command(standard(IdInput), async ({ id }): Promise<void> => {
	const admin = requireAdmin();
	await withOps((b) => b.deleteSink(id, admin.login));
	await listOpsSinks().refresh();
});

export const testOpsSink = command(standard(TestSinkInput), async (input): Promise<TestConnectionResult> => {
	const admin = requireAdmin();
	const result = await withOps((b) => b.testSink(input, admin.login));
	if (input.id) await listOpsSinks().refresh();
	return result;
});

// ---------------------------------------------------------------------------
// Secrets & keys — write-only
// ---------------------------------------------------------------------------

export const listOpsSecrets = query(async (): Promise<SecretMeta[]> => {
	requireUser();
	return withOps((b) => b.listSecrets());
});

export const getOpsKeyStatus = query(async (): Promise<KeyStatus> => {
	requireUser();
	return withOps((b) => b.getKeyStatus());
});

/**
 * Store or replace a secret (form: `id?`, `name`, `kind`, `value`). The value
 * is posted once and never echoed: the result is metadata only.
 */
export const setOpsSecret = form(standard(SetSecretInput), async (input, issue): Promise<SecretMeta> => {
	const admin = requireAdmin();
	let meta: SecretMeta;
	try {
		meta = await getOpsBackend().setSecret(input, admin.login);
	} catch (e) {
		if (isOpsBackendError(e) && e.code === 'invalid') invalid(issue.value(e.message));
		if (isOpsBackendError(e)) error(opsBackendErrorStatus(e.code), e.message);
		throw e;
	}
	await listOpsSecrets().refresh();
	return meta;
});

export const deleteOpsSecret = command(standard(IdInput), async ({ id }): Promise<void> => {
	const admin = requireAdmin();
	await withOps((b) => b.deleteSecret(id, admin.login));
	await listOpsSecrets().refresh();
});

// ---------------------------------------------------------------------------
// Budgets, config export/import, actors
// ---------------------------------------------------------------------------

export const getOpsBudgets = query(async () => {
	requireUser();
	return withOps((b) => b.getBudgets());
});

export const saveOpsBudgets = command(standard(Budgets), async (budgets) => {
	const admin = requireAdmin();
	const saved = await withOps((b) => b.saveBudgets(budgets, admin.login));
	await getOpsBudgets().refresh();
	return saved;
});

/** Config as JSON (no secret values; secret refs only). Admin, because it lists infrastructure. */
export const exportOpsConfig = command(async (): Promise<ConfigExport> => {
	requireAdmin();
	return withOps((b) => b.exportConfig());
});

export const importOpsConfig = command(standard(ConfigExport), async (config): Promise<ImportResult> => {
	const admin = requireAdmin();
	const result = await withOps((b) => b.importConfig(config, admin.login));
	await Promise.all([listOpsDestinations().refresh(), listOpsPlans().refresh(), listOpsSinks().refresh(), getOpsBudgets().refresh()]);
	return result;
});

export const listOpsActors = query(async (): Promise<OpsActorSummary[]> => {
	requireUser();
	return withOps((b) => b.listOpsActors());
});
