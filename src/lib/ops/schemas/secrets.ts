/** Secret store DTOs (ADR 0086). No DTO ever carries a plaintext value outward. */
import { Type, type Static } from '@sinclair/typebox';
import { OpsId, Timestamp } from './common';

export const SecretKind = Type.Union([
	Type.Literal('r2-secret-access-key'),
	Type.Literal('s3-secret-access-key'),
	Type.Literal('exe-vm-token'),
	Type.Literal('bearer-token'),
	Type.Literal('basic-password'),
	Type.Literal('header-value')
]);
export type SecretKind = Static<typeof SecretKind>;

export const SecretMeta = Type.Object(
	{
		id: OpsId,
		name: Type.String({ minLength: 1, maxLength: 80 }),
		kind: SecretKind,
		/** e.g. "…a1b2 · 3f9c02" (last 4 chars + keyed-hash prefix). */
		fingerprint: Type.String(),
		kekId: Type.String({ pattern: '^[0-9a-f]{16}$' }),
		/** false → still wrapped by OPS_MASTER_KEY_PREVIOUS (rewrap pending). */
		kekCurrent: Type.Boolean(),
		createdAt: Timestamp,
		updatedAt: Timestamp,
		lastUsedAt: Type.Union([Timestamp, Type.Null()]),
		lastUsedOk: Type.Union([Type.Boolean(), Type.Null()]),
		/** Config items that reference it. */
		usedBy: Type.Array(Type.Object({ area: Type.String(), id: OpsId }))
	},
	{ additionalProperties: false }
);
export type SecretMeta = Static<typeof SecretMeta>;

/** Write-only input. `id` present → replace value of an existing secret. */
export const SetSecretInput = Type.Object(
	{
		id: Type.Optional(OpsId),
		name: Type.String({ minLength: 1, maxLength: 80 }),
		kind: SecretKind,
		value: Type.String({ minLength: 1, maxLength: 8192 })
	},
	{ additionalProperties: false }
);
export type SetSecretInput = Static<typeof SetSecretInput>;

export const KeyStatus = Type.Object({
	/** 'missing' → ops is degraded (ADR 0086). */
	master: Type.Union([Type.Literal('ok'), Type.Literal('missing'), Type.Literal('dev-generated')]),
	kekId: Type.Union([Type.String(), Type.Null()]),
	previousKekPresent: Type.Boolean(),
	secretsOnPreviousKek: Type.Integer({ minimum: 0 }),
	/** Retained backups whose KEK is no longer configured (unrestorable, ADR 0097). */
	backupsOnMissingKek: Type.Integer({ minimum: 0 })
});
export type KeyStatus = Static<typeof KeyStatus>;
