/**
 * Seeds (ADR 0102, 0106, 0110): optional env vars create config rows only if
 * a row with that seed id does not exist; seeds never overwrite rows a human
 * edited and never delete anything. Seeded secrets go straight into the
 * secret store. With nothing configured there is still a backup: a
 * `local-dir` destination (one copy) and an hourly plan.
 */
import type { SecretStore } from './secrets/store';
import type { BackupsRepo, DestinationConfig } from './backups/repo';
import { DEFAULT_BUDGETS } from './schemas/budgets';
import { GiB } from './schemas/common';
import { DEFAULT_DRILL_INTERVAL_MS, DEFAULT_INTERVAL_MS } from './schemas/plans';
import type { R2Jurisdiction, RetentionCaps, RetentionSchedule } from './schemas/destinations';

export const SEED_IDS = { r2: 'seed-r2', s3: 'seed-s3', local: 'seed-local', plan: 'seed-all', r2Secret: 'seed-r2-secret', s3Secret: 'seed-s3-secret', otlpToken: 'seed-otlp-token' } as const;

export const DEFAULT_SCHEDULE: RetentionSchedule = { keepAllHours: 48, dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12, floor: 3 };
/** ADR 0108: 8 GiB and 82 backups per database. */
export const defaultCaps = (): RetentionCaps => ({ maxBytes: 8 * GiB, maxBackupsPerDatabase: 82 });

const parseInterval = (s: string | undefined): number => {
	const m = s ? /^(\d+)(m|h)$/.exec(s) : null;
	if (!m) return DEFAULT_INTERVAL_MS;
	return Math.max(5_000, Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000));
};

const normPrefix = (p: string | undefined, fallback: string) => {
	const v = (p ?? fallback).replace(/^\/+/, '');
	return v === '' || v.endsWith('/') ? v : `${v}/`;
};

export interface SeedResult {
	created: string[];
	skipped: string[];
}

export async function runSeeds(opts: { env: Record<string, string | undefined>; repo: BackupsRepo; secrets: SecretStore; databases: string[] }): Promise<SeedResult> {
	const { env, repo, secrets } = opts;
	const out: SeedResult = { created: [], skipped: [] };
	const has = (id: string) => !!repo.destinationRow(id);
	const canStoreSecrets = !!secrets.keys.current;
	const caps = defaultCaps();

	const seedSecret = async (id: string, name: string, kind: 'r2-secret-access-key' | 's3-secret-access-key', value: string) => {
		if (!secrets.exists(id)) await secrets.set({ name, kind, value }, 'seed', { createId: id });
	};

	// R2 (ADR 0095, 0106)
	if (env.OPS_SEED_R2_ACCOUNT_ID && env.OPS_SEED_R2_BUCKET && env.OPS_SEED_R2_ACCESS_KEY_ID && env.OPS_SEED_R2_SECRET_ACCESS_KEY) {
		if (has(SEED_IDS.r2)) out.skipped.push(SEED_IDS.r2);
		else if (!canStoreSecrets) out.skipped.push(`${SEED_IDS.r2} (no master key)`);
		else {
			await seedSecret(SEED_IDS.r2Secret, 'R2 secret access key (seed)', 'r2-secret-access-key', env.OPS_SEED_R2_SECRET_ACCESS_KEY);
			const config: DestinationConfig = {
				settings: {
					kind: 'r2',
					accountId: env.OPS_SEED_R2_ACCOUNT_ID,
					jurisdiction: (env.OPS_SEED_R2_JURISDICTION as R2Jurisdiction | undefined) ?? 'eu',
					bucket: env.OPS_SEED_R2_BUCKET,
					prefix: normPrefix(env.OPS_SEED_R2_PREFIX, 'granary/'),
					accessKeyId: env.OPS_SEED_R2_ACCESS_KEY_ID,
					secretAccessKey: { secretRef: SEED_IDS.r2Secret },
					...(env.OPS_SEED_R2_ENDPOINT_OVERRIDE ? { endpointOverride: env.OPS_SEED_R2_ENDPOINT_OVERRIDE.replace(/\/+$/, '') } : {})
				},
				retention: DEFAULT_SCHEDULE,
				caps,
				...(env.OPS_SEED_R2_CONSOLE_URL ? { consoleUrl: env.OPS_SEED_R2_CONSOLE_URL } : {})
			};
			repo.insertDestination({ id: SEED_IDS.r2, name: 'Cloudflare R2 (seed)', enabled: true, origin: 'seed', config });
			out.created.push(SEED_IDS.r2);
		}
	}

	// Generic S3 (fake-infra, RustFS)
	if (env.OPS_SEED_S3_ENDPOINT && env.OPS_SEED_S3_BUCKET && env.OPS_SEED_S3_ACCESS_KEY_ID && env.OPS_SEED_S3_SECRET_ACCESS_KEY) {
		if (has(SEED_IDS.s3)) out.skipped.push(SEED_IDS.s3);
		else if (!canStoreSecrets) out.skipped.push(`${SEED_IDS.s3} (no master key)`);
		else {
			await seedSecret(SEED_IDS.s3Secret, 'S3 secret access key (seed)', 's3-secret-access-key', env.OPS_SEED_S3_SECRET_ACCESS_KEY);
			const config: DestinationConfig = {
				settings: {
					kind: 's3',
					endpoint: env.OPS_SEED_S3_ENDPOINT.replace(/\/+$/, ''),
					region: env.OPS_SEED_S3_REGION ?? 'auto',
					bucket: env.OPS_SEED_S3_BUCKET,
					prefix: normPrefix(env.OPS_SEED_S3_PREFIX, 'granary/'),
					virtualHostedStyle: false,
					accessKeyId: env.OPS_SEED_S3_ACCESS_KEY_ID,
					secretAccessKey: { secretRef: SEED_IDS.s3Secret }
				},
				retention: DEFAULT_SCHEDULE,
				caps,
				...(env.OPS_SEED_S3_CONSOLE_URL ? { consoleUrl: env.OPS_SEED_S3_CONSOLE_URL } : {})
			};
			repo.insertDestination({ id: SEED_IDS.s3, name: 'S3-compatible (seed)', enabled: true, origin: 'seed', config });
			out.created.push(SEED_IDS.s3);
		}
	}

	// Console links (ADR 0154): fill a missing link on seed rows nobody edited,
	// so an existing database picks up a newly added seed env var.
	for (const [id, url] of [[SEED_IDS.r2, env.OPS_SEED_R2_CONSOLE_URL], [SEED_IDS.s3, env.OPS_SEED_S3_CONSOLE_URL]] as const) {
		if (url && repo.fillSeedConsoleUrl(id, url)) out.created.push(`${id} console link`);
	}

	// Telemetry token seed (ADR 0122, 0150): the health feature's seed sink
	// `seed-otlp` references the secret `seed-otlp-token`; the secret store
	// belongs to backups, so the value is stored here. Never overwritten.
	if (env.OPS_SEED_OTLP_TOKEN) {
		const mode = env.OPS_SEED_OTLP_AUTH ?? 'none';
		const kind = mode === 'exe-vm-token' ? 'exe-vm-token' : mode === 'bearer' ? 'bearer-token' : mode === 'basic' ? 'basic-password' : null;
		if (!kind) out.skipped.push(`${SEED_IDS.otlpToken} (OPS_SEED_OTLP_AUTH=${mode} takes no token)`);
		else if (!canStoreSecrets) out.skipped.push(`${SEED_IDS.otlpToken} (no master key)`);
		else if (secrets.exists(SEED_IDS.otlpToken)) out.skipped.push(SEED_IDS.otlpToken);
		else {
			await secrets.set({ name: 'OTLP token (seed)', kind, value: env.OPS_SEED_OTLP_TOKEN }, 'seed', { createId: SEED_IDS.otlpToken });
			out.created.push(SEED_IDS.otlpToken);
		}
	}

	// Always: a local copy on the VM disk (fast restores, not safety; ADR 0098).
	if (has(SEED_IDS.local)) out.skipped.push(SEED_IDS.local);
	else {
		repo.insertDestination({
			id: SEED_IDS.local,
			name: 'Local copy (same disk)',
			enabled: true,
			origin: 'seed',
			config: { settings: { kind: 'local-dir', path: 'backups', maxCopies: 1 }, retention: { ...DEFAULT_SCHEDULE, floor: 1 }, caps }
		});
		out.created.push(SEED_IDS.local);
	}

	// Plan over all databases → every seeded destination.
	const destinationIds = [SEED_IDS.local, SEED_IDS.r2, SEED_IDS.s3].filter((id) => has(id));
	if (repo.plan(SEED_IDS.plan)) out.skipped.push(SEED_IDS.plan);
	else {
		repo.insertPlan({
			id: SEED_IDS.plan,
			name: 'All databases (seed)',
			enabled: true,
			origin: 'seed',
			config: { databases: opts.databases, destinationIds, intervalMs: parseInterval(env.OPS_SEED_BACKUP_INTERVAL), drillIntervalMs: DEFAULT_DRILL_INTERVAL_MS }
		});
		out.created.push(SEED_IDS.plan);
	}

	// Budgets (ADR 0107): egress budget seed.
	const gib = env.OPS_SEED_EGRESS_BUDGET_GIB ? Number(env.OPS_SEED_EGRESS_BUDGET_GIB) : null;
	repo.seedBudgets({ ...DEFAULT_BUDGETS, ...(gib ? { r2EgressBytesPerMonth: Math.max(GiB, Math.round(gib * GiB)) } : {}) });
	return out;
}
