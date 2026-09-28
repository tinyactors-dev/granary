/** DTOs of the OpsBackend seam (ADR 0092, 0104). Inputs are validated with `standard()` in remote functions. */
import { Type, type Static } from '@sinclair/typebox';
import { Bytes, DatabaseId, OpsId, PageInput, Timestamp } from './common';
import { OpsEventKind } from './conditions';
import { RunState } from './runs';
import { DestinationDraft } from './destinations';
import { TelemetrySinkDraft } from './sinks';
import { SetSecretInput } from './secrets';

export const IdInput = Type.Object({ id: OpsId }, { additionalProperties: false });
export type IdInput = Static<typeof IdInput>;

export const ListRunsInput = Type.Object(
	{ planId: Type.Optional(OpsId), state: Type.Optional(RunState), database: Type.Optional(DatabaseId), ...PageInput },
	{ additionalProperties: false }
);
export type ListRunsInput = Static<typeof ListRunsInput>;

export const ListEventsInput = Type.Object({ kind: Type.Optional(OpsEventKind), ...PageInput }, { additionalProperties: false });
export type ListEventsInput = Static<typeof ListEventsInput>;

export const ListDrillsInput = Type.Object({ destinationId: Type.Optional(OpsId), ...PageInput }, { additionalProperties: false });
export type ListDrillsInput = Static<typeof ListDrillsInput>;

/** `limit` resolved (default 50). */
export type Resolved<T extends { limit?: number }> = Omit<T, 'limit'> & { limit: number };

/** Test connection: an existing item, or a draft plus unsaved candidate secret values (ADR 0086). */
export const TestDestinationInput = Type.Object(
	{
		id: Type.Optional(OpsId),
		draft: Type.Optional(DestinationDraft),
		/** secretRef id → candidate plaintext; used for this test only, then discarded. */
		candidateSecrets: Type.Optional(Type.Record(OpsId, Type.String({ minLength: 1, maxLength: 8192 })))
	},
	{ additionalProperties: false }
);
export type TestDestinationInput = Static<typeof TestDestinationInput>;

export const TestSinkInput = Type.Object(
	{
		id: Type.Optional(OpsId),
		draft: Type.Optional(TelemetrySinkDraft),
		candidateSecrets: Type.Optional(Type.Record(OpsId, Type.String({ minLength: 1, maxLength: 8192 })))
	},
	{ additionalProperties: false }
);
export type TestSinkInput = Static<typeof TestSinkInput>;

/** One step of a test connection (ADR 0095): PUT, HEAD, LIST, GET, conditional PUT, DELETE, HEAD-404. */
export const TestStep = Type.Object({
	name: Type.String(),
	ok: Type.Boolean(),
	skipped: Type.Boolean(),
	durationMs: Type.Integer({ minimum: 0 }),
	detail: Type.Union([Type.String(), Type.Null()]),
	providerCode: Type.Union([Type.String(), Type.Null()])
});
export type TestStep = Static<typeof TestStep>;

export const TestConnectionResult = Type.Object({
	ok: Type.Boolean(),
	at: Timestamp,
	/** e.g. the derived R2 endpoint, so a wrong jurisdiction is obvious (ADR 0106). */
	resolvedEndpoint: Type.Union([Type.String(), Type.Null()]),
	steps: Type.Array(TestStep),
	/** Manual checklist items (ADR 0095), not automatable with an object-scoped token. */
	advisories: Type.Array(Type.Object({ title: Type.String(), detail: Type.String(), docsUrl: Type.Union([Type.String(), Type.Null()]) }))
});
export type TestConnectionResult = Static<typeof TestConnectionResult>;

/** Retention dry-run (ADR 0096): exactly what the next pass would delete. */
export const RetentionPreview = Type.Object({
	destinationId: OpsId,
	at: Timestamp,
	keep: Type.Array(Type.Object({ key: Type.String(), database: DatabaseId, createdAt: Timestamp, bytes: Bytes, reason: Type.String() })),
	delete: Type.Array(Type.Object({ key: Type.String(), database: Type.Union([DatabaseId, Type.Null()]), createdAt: Type.Union([Timestamp, Type.Null()]), bytes: Bytes, reason: Type.String() })),
	unknownObjects: Type.Integer({ minimum: 0 }),
	totalBytesAfter: Bytes,
	backupsAfterPerDatabase: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
	floorExceedsCap: Type.Boolean()
});
export type RetentionPreview = Static<typeof RetentionPreview>;

/** Projected storage and egress (ADR 0096, 0098, 0107). */
export const Projections = Type.Object({
	destinationId: OpsId,
	storage: Type.Object({
		steadyStateBackups: Type.Integer({ minimum: 0 }),
		averageSealedBytes: Bytes,
		steadyStateBytes: Bytes,
		capBytes: Bytes,
		capBackupsPerDatabase: Type.Integer(),
		/** From the last 14 days of sizes; null when not growing or unknown. */
		monthsUntilCap: Type.Union([Type.Number(), Type.Null()]),
		explanation: Type.String()
	}),
	/** Only for off-site destinations; R2 uploads are billed exe.dev egress. */
	egress: Type.Union([
		Type.Null(),
		Type.Object({
			usedThisMonthBytes: Bytes,
			projectedMonthBytes: Bytes,
			budgetBytes: Bytes,
			configuredIntervalMs: Type.Integer(),
			effectiveIntervalMs: Type.Integer(),
			stretched: Type.Boolean(),
			explanation: Type.String()
		})
	])
});
export type Projections = Static<typeof Projections>;

export const TelemetryStats = Type.Object({
	sinkId: OpsId,
	windowMs: Type.Integer(),
	sentBatches: Type.Integer({ minimum: 0 }),
	sentBytes: Bytes,
	droppedBatches: Type.Integer({ minimum: 0 }),
	droppedBytes: Bytes,
	bufferedBytes: Bytes,
	sampleRatio: Type.Number({ minimum: 0, maximum: 1 }),
	volumeThisMonthBytes: Bytes,
	volumeBudgetBytes: Bytes,
	lastError: Type.Union([Type.String(), Type.Null()])
});
export type TelemetryStats = Static<typeof TelemetryStats>;

export const DownloadLink = Type.Object({ url: Type.String(), expiresAt: Timestamp });
export type DownloadLink = Static<typeof DownloadLink>;

/** Config export (no secrets; secretRefs kept) (ADR 0102). */
export const ConfigExport = Type.Object({
	format: Type.Literal('granary-ops-config/1'),
	exportedAt: Timestamp,
	destinations: Type.Array(Type.Unknown()),
	plans: Type.Array(Type.Unknown()),
	sinks: Type.Array(Type.Unknown()),
	budgets: Type.Unknown(),
	secretRefs: Type.Array(Type.Object({ id: OpsId, name: Type.String(), kind: Type.String() }))
});
export type ConfigExport = Static<typeof ConfigExport>;

export const ImportResult = Type.Object({
	created: Type.Integer(),
	updated: Type.Integer(),
	skipped: Type.Integer(),
	missingSecrets: Type.Array(OpsId)
});
export type ImportResult = Static<typeof ImportResult>;

export const OpsActorSummary = Type.Object({
	address: Type.Object({ family: Type.String(), name: Type.String() }),
	activeStates: Type.Array(Type.String()),
	scheduling: Type.String()
});
export type OpsActorSummary = Static<typeof OpsActorSummary>;

export { SetSecretInput };
