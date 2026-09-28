/**
 * Shared primitives for the ops contract (ADR 0080, 0109).
 * Timestamps are epoch milliseconds; sizes are bytes; durations are ms.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';

/** Ops ids: lower-case slug; seed rows use `seed-<name>` (ADR 0109). Safe inside actor addresses. */
export const OpsId = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$' });
export type OpsId = Static<typeof OpsId>;

export const Timestamp = Type.Integer({ minimum: 0, description: 'epoch ms' });
export const DurationMs = Type.Integer({ minimum: 0 });
export const Bytes = Type.Integer({ minimum: 0 });

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;

/** Who created a config row (ADR 0102): seeds never overwrite `ui` rows. */
export const Origin = Type.Union([Type.Literal('seed'), Type.Literal('ui')]);
export type Origin = Static<typeof Origin>;

/** A reference to a stored secret; the value is never part of any DTO (ADR 0086). */
export const SecretRef = Type.Object(
	{ secretRef: OpsId },
	{ additionalProperties: false, description: 'reference into the ops secret store' }
);
export type SecretRef = Static<typeof SecretRef>;

/** Common columns of every config item. */
export const ConfigMeta = {
	id: OpsId,
	name: Type.String({ minLength: 1, maxLength: 80 }),
	enabled: Type.Boolean(),
	origin: Origin,
	/** Optimistic concurrency: the UI sends back the version it edited. */
	version: Type.Integer({ minimum: 1 }),
	createdAt: Timestamp,
	updatedAt: Timestamp
};

/** Page of results; pass `nextCursor` back as `before`. */
export const Page = <T extends TSchema>(item: T) =>
	Type.Object({ items: Type.Array(item), nextCursor: Type.Union([Type.String(), Type.Null()]) });
export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

export const PageInput = {
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	before: Type.Optional(Type.String({ maxLength: 200 }))
};

/** Which database is backed up (OpsHost.databases ids). */
export const DatabaseId = Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' });
export type DatabaseId = Static<typeof DatabaseId>;
