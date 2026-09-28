/**
 * Backup manifest — the commit marker (ADR 0084, 0095). Encryption is a
 * required block with a literal algorithm (ADR 0097): no plaintext variant.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Bytes, DatabaseId, OpsId, Timestamp } from './common';

const Sha256 = Type.String({ pattern: '^[0-9a-f]{64}$' });

export const BackupManifest = Type.Object(
	{
		format: Type.Literal('granary-ops-backup/1'),
		runId: OpsId,
		database: DatabaseId,
		createdAt: Timestamp,
		granaryVersion: Type.String(),
		sqliteVersion: Type.String(),
		userVersion: Type.Integer(),
		pageCount: Type.Integer({ minimum: 0 }),
		rowCounts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
		raw: Type.Object({ bytes: Bytes, sha256: Sha256 }),
		compressed: Type.Object({ alg: Type.Literal('zstd'), level: Type.Integer({ minimum: 1, maximum: 22 }), bytes: Bytes, sha256: Sha256 }),
		sealed: Type.Object({ bytes: Bytes, sha256: Sha256 }),
		encryption: Type.Object(
			{
				alg: Type.Literal('AES-256-GCM'),
				chunkBytes: Type.Integer({ minimum: 65536 }),
				kekId: Type.String({ pattern: '^[0-9a-f]{16}$' }),
				/** base64 DEK wrapped under the KEK. */
				wrappedDek: Type.String({ minLength: 16 }),
				/** base64 96-bit nonce base; chunk i uses base XOR i. */
				nonceBase: Type.String({ minLength: 16 })
			},
			{ additionalProperties: false }
		),
		artifactKey: Type.String()
	},
	{ additionalProperties: false }
);
export type BackupManifest = Static<typeof BackupManifest>;
