/**
 * Ops environment (ADR 0086, 0102, 0106, 0109). Read from `OpsHost.env`,
 * never from `process.env` directly and never via granary's config module.
 * Only key material and seeds; everything else is configured in-product.
 */
import { Type, type Static } from '@sinclair/typebox';
import { issuesOf } from '../../schemas/standard';

const NonEmpty = Type.String({ minLength: 1 });

export const OpsEnv = Type.Object(
	{
		OPS_MASTER_KEY: Type.Optional(NonEmpty),
		OPS_MASTER_KEY_PREVIOUS: Type.Optional(NonEmpty),
		OPS_DATABASE_PATH: Type.Optional(NonEmpty),
		// R2 seed (ADR 0095, 0106)
		OPS_SEED_R2_ACCOUNT_ID: Type.Optional(Type.String({ pattern: '^[0-9a-f]{32}$' })),
		OPS_SEED_R2_JURISDICTION: Type.Optional(Type.Union([Type.Literal('default'), Type.Literal('eu'), Type.Literal('fedramp')])),
		OPS_SEED_R2_BUCKET: Type.Optional(NonEmpty),
		OPS_SEED_R2_PREFIX: Type.Optional(Type.String()),
		OPS_SEED_R2_ACCESS_KEY_ID: Type.Optional(NonEmpty),
		OPS_SEED_R2_SECRET_ACCESS_KEY: Type.Optional(NonEmpty),
		/** Dev/test: point the seeded R2 destination at fake-infra (ADR 0112). */
		OPS_SEED_R2_ENDPOINT_OVERRIDE: Type.Optional(Type.String({ pattern: '^https?://' })),
		// generic S3 seed (fake-infra, RustFS)
		OPS_SEED_S3_ENDPOINT: Type.Optional(Type.String({ pattern: '^https?://' })),
		OPS_SEED_S3_REGION: Type.Optional(NonEmpty),
		OPS_SEED_S3_BUCKET: Type.Optional(NonEmpty),
		OPS_SEED_S3_PREFIX: Type.Optional(Type.String()),
		OPS_SEED_S3_ACCESS_KEY_ID: Type.Optional(NonEmpty),
		OPS_SEED_S3_SECRET_ACCESS_KEY: Type.Optional(NonEmpty),
		// plan & budgets
		OPS_SEED_BACKUP_INTERVAL: Type.Optional(Type.String({ pattern: '^[0-9]+(m|h)$' })),
		OPS_SEED_EGRESS_BUDGET_GIB: Type.Optional(Type.String({ pattern: '^[0-9]+(\\.[0-9]+)?$' })),
		// telemetry seed (ADR 0099)
		OPS_SEED_OTLP_ENDPOINT: Type.Optional(Type.String({ pattern: '^https?://' })),
		OPS_SEED_OTLP_AUTH: Type.Optional(
			Type.Union([
				Type.Literal('exe-peer'),
				Type.Literal('exe-vm-token'),
				Type.Literal('none'),
				Type.Literal('bearer'),
				Type.Literal('basic')
			])
		),
		OPS_SEED_OTLP_TOKEN: Type.Optional(NonEmpty),
		/** Username for `OPS_SEED_OTLP_AUTH=basic` (ADR 0122); default `granary`. */
		OPS_SEED_OTLP_USERNAME: Type.Optional(NonEmpty),
		OTEL_EXPORTER_OTLP_ENDPOINT: Type.Optional(Type.String()),
		OTEL_EXPORTER_OTLP_HEADERS: Type.Optional(Type.String()),
		// test-only hooks (ADR 0103)
		OPS_TEST_STATFS_OVERRIDE: Type.Optional(Type.String({ pattern: '^[0-9]+/[0-9]+$', description: 'free/total bytes' })),
		OPS_WATCHDOG_INTERVAL_MS: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
		// backups test timings (agent A, ADR 0111)
		OPS_TEST_RETRY_BASE_MS: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
		OPS_TEST_RETENTION_INTERVAL_MS: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
		/** Test hook: multiply condition grace/settle periods, e.g. 0.001 (ADR 0123). */
		OPS_TEST_GRACE_SCALE: Type.Optional(Type.String({ pattern: '^[0-9]+(\\.[0-9]+)?$' }))
	},
	{ additionalProperties: true }
);
export type OpsEnv = Static<typeof OpsEnv>;

/** Validate the ops-relevant subset of an environment; returns problems (empty = ok). */
export function checkOpsEnv(env: Record<string, string | undefined>): string[] {
	const cleaned: Record<string, string> = {};
	for (const key of Object.keys(OpsEnv.properties)) {
		const v = env[key];
		if (v !== undefined && v !== '') cleaned[key] = v;
	}
	return issuesOf(OpsEnv, cleaned).map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`);
}
