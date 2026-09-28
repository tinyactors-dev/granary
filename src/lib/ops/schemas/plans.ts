/** Backup plans (ADR 0082, 0098, 0107). */
import { Type, type Static } from '@sinclair/typebox';
import { ConfigMeta, DatabaseId, DurationMs, OpsId } from './common';

export const BackupPlan = Type.Object(
	{
		...ConfigMeta,
		databases: Type.Array(DatabaseId, { minItems: 1, uniqueItems: true }),
		destinationIds: Type.Array(OpsId, { minItems: 1, uniqueItems: true }),
		/** Configured interval (default 1 h). */
		intervalMs: Type.Integer({ minimum: 5_000, maximum: 24 * 3_600_000 }),
		/** Interval actually used; stretched (max 6 h) when the R2 egress budget would be exceeded. */
		effectiveIntervalMs: DurationMs,
		/** Weekly drill per destination by default. */
		drillIntervalMs: Type.Integer({ minimum: 60_000, maximum: 30 * 86_400_000 })
	},
	{ additionalProperties: false }
);
export type BackupPlan = Static<typeof BackupPlan>;

export const BackupPlanDraft = Type.Object(
	{
		id: Type.Optional(OpsId),
		name: ConfigMeta.name,
		enabled: Type.Boolean(),
		databases: BackupPlan.properties.databases,
		destinationIds: BackupPlan.properties.destinationIds,
		intervalMs: BackupPlan.properties.intervalMs,
		drillIntervalMs: BackupPlan.properties.drillIntervalMs,
		version: Type.Optional(Type.Integer({ minimum: 1 }))
	},
	{ additionalProperties: false }
);
export type BackupPlanDraft = Static<typeof BackupPlanDraft>;

export const MAX_STRETCHED_INTERVAL_MS = 6 * 3_600_000;
export const DEFAULT_INTERVAL_MS = 3_600_000;
export const DEFAULT_DRILL_INTERVAL_MS = 7 * 86_400_000;
