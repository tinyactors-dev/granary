/**
 * Backup destinations (ADR 0084, 0095, 0096, 0098, 0106).
 * Encryption is mandatory and therefore NOT configurable (ADR 0097);
 * storage class is fixed to STANDARD (no archive tier, ADR 0096).
 */
import { Type, type Static } from '@sinclair/typebox';
import { ConfigMeta, GiB, SecretRef, Timestamp } from './common';

export const R2Jurisdiction = Type.Union([Type.Literal('default'), Type.Literal('eu'), Type.Literal('fedramp')]);
export type R2Jurisdiction = Static<typeof R2Jurisdiction>;

/** GFS schedule (ADR 0096; confirmed in ADR 0108). */
export const RetentionSchedule = Type.Object(
	{
		keepAllHours: Type.Integer({ minimum: 1, maximum: 168, default: 48 }),
		dailyDays: Type.Integer({ minimum: 0, maximum: 60, default: 14 }),
		weeklyWeeks: Type.Integer({ minimum: 0, maximum: 26, default: 8 }),
		monthlyMonths: Type.Integer({ minimum: 0, maximum: 24, default: 12 }),
		/** Newest verified backups per database always kept. */
		floor: Type.Integer({ minimum: 1, maximum: 10, default: 3 })
	},
	{ additionalProperties: false }
);
export type RetentionSchedule = Static<typeof RetentionSchedule>;

/** Hard caps — required, bounded (ADR 0096). */
export const RetentionCaps = Type.Object(
	{
		maxBytes: Type.Integer({ minimum: 64 * 1024 ** 2, maximum: 100 * GiB, default: 8 * GiB }),
		maxBackupsPerDatabase: Type.Integer({ minimum: 3, maximum: 200, default: 82 })
	},
	{ additionalProperties: false }
);
export type RetentionCaps = Static<typeof RetentionCaps>;

export const R2Settings = Type.Object(
	{
		kind: Type.Literal('r2'),
		accountId: Type.String({ pattern: '^[0-9a-f]{32}$' }),
		jurisdiction: R2Jurisdiction,
		bucket: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' }),
		prefix: Type.String({ maxLength: 200, pattern: '^([A-Za-z0-9._-]+/)*$' }),
		/** Not secret (it's the token id), stored in clear for display. */
		accessKeyId: Type.String({ minLength: 1, maxLength: 128 }),
		secretAccessKey: SecretRef
	},
	{ additionalProperties: false }
);

export const S3Settings = Type.Object(
	{
		kind: Type.Literal('s3'),
		endpoint: Type.String({ pattern: '^https?://[^\\s/]+(:[0-9]+)?/?$' }),
		region: Type.String({ minLength: 1, maxLength: 40 }),
		bucket: Type.String({ minLength: 3, maxLength: 63 }),
		prefix: Type.String({ maxLength: 200, pattern: '^([A-Za-z0-9._-]+/)*$' }),
		virtualHostedStyle: Type.Boolean(),
		accessKeyId: Type.String({ minLength: 1, maxLength: 128 }),
		secretAccessKey: SecretRef
	},
	{ additionalProperties: false }
);

/** On-box copy for fast restores; at most one copy (ADR 0098). */
export const LocalDirSettings = Type.Object(
	{
		kind: Type.Literal('local-dir'),
		/** Relative paths are resolved against OpsHost.dataDir. */
		path: Type.String({ minLength: 1, maxLength: 500 }),
		maxCopies: Type.Literal(1)
	},
	{ additionalProperties: false }
);

export const DestinationSettings = Type.Union([R2Settings, S3Settings, LocalDirSettings]);
export type DestinationSettings = Static<typeof DestinationSettings>;
export type DestinationKind = DestinationSettings['kind'];

export const Destination = Type.Object(
	{
		...ConfigMeta,
		settings: DestinationSettings,
		retention: RetentionSchedule,
		caps: RetentionCaps,
		/** Last test connection with the current values; enabling requires ok (ADR 0102). */
		lastTest: Type.Union([
			Type.Null(),
			Type.Object({ at: Timestamp, ok: Type.Boolean(), versionTested: Type.Integer({ minimum: 1 }) })
		])
	},
	{ additionalProperties: false }
);
export type Destination = Static<typeof Destination>;

/** What the UI submits (no meta; secret values go through `setSecret` first or inline below). */
export const DestinationDraft = Type.Object(
	{
		id: Type.Optional(ConfigMeta.id),
		name: ConfigMeta.name,
		enabled: Type.Boolean(),
		settings: DestinationSettings,
		retention: RetentionSchedule,
		caps: RetentionCaps,
		/** Required when updating an existing row. */
		version: Type.Optional(Type.Integer({ minimum: 1 }))
	},
	{ additionalProperties: false }
);
export type DestinationDraft = Static<typeof DestinationDraft>;

/** R2 S3 endpoint for an account/jurisdiction (ADR 0106). Region is always `auto`. */
export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction): string {
	const j = jurisdiction === 'default' ? '' : `.${jurisdiction}`;
	return `https://${accountId}${j}.r2.cloudflarestorage.com`;
}
export const R2_REGION = 'auto';

/** Upload tuning shared by every S3-compatible destination (ADR 0095). */
export const UPLOAD_TUNING = { partSize: 8 * 1024 ** 2, queueSize: 4, retry: 3 } as const;

/** Object keys (ADR 0084): `<prefix><db>/<yyyy>/<mm>/<dd>/<runId>.sqlite.zst.aesgcm` + `.manifest.json`. */
export function artifactKey(prefix: string, database: string, runId: string, at: number): string {
	const d = new Date(at);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${prefix}${database}/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${runId}.sqlite.zst.aesgcm`;
}
export const manifestKeyOf = (artifact: string) => `${artifact}.manifest.json`;
export const PROBE_PREFIX = '.ops-probe/';
