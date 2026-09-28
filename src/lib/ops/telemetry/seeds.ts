/**
 * Telemetry sink seeds (ADR 0102, 0110, 0122). One sink, id `seed-otlp`:
 * from `GRANARY_SEED_OTLP_ENDPOINT` + `GRANARY_SEED_OTLP_AUTH` (token auth
 * modes use the secret `seed-otlp-token`, which the backups feature's seeds
 * create from `GRANARY_SEED_OTLP_TOKEN`; without it the sink is created
 * disabled), plus `GRANARY_SEED_OTLP_USERNAME` and `GRANARY_SEED_OTLP_GRAFANA_URL`.
 * Seeds are enabled without a test connection (the operator asserted them in
 * the environment). They never overwrite a row edited in the UI
 * (`origin = 'ui'`), and removing the env var deletes nothing.
 */
import type { Database } from 'bun:sqlite';
import type { OpsLogger } from '../contract';
import type { SinkAuth } from '../schemas/sinks';
import { GiB } from '../schemas/common';
import { SINK_DEFAULTS, type SinksRepo } from './sinks-repo';

export const SEED_SINK_ID = 'seed-otlp';
export const SEED_SINK_TOKEN_REF = 'seed-otlp-token';
const URL_RE = /^https?:\/\/[^\s]+$/;

function secretExists(db: Database, id: string): boolean {
	try {
		return !!db.query('SELECT 1 FROM secrets WHERE id = $id').get({ id });
	} catch {
		return false;
	}
}

export function seedSinks(deps: { repo: SinksRepo; env: Record<string, string | undefined>; db: Database; now: number; log: OpsLogger }): string[] {
	const { repo, env } = deps;
	const existing = repo.get(SEED_SINK_ID);
	if (existing && existing.origin === 'ui') return [];

	let endpoint: string | null = null;
	let auth: SinkAuth = { mode: 'none' };
	let enabled = true;
	const exportOps = true;
	/** Seeded sinks flush every second (tests and dev want spans promptly). */
	const flushIntervalMs = 1_000;
	let why = '';

	if (env.GRANARY_SEED_OTLP_ENDPOINT && URL_RE.test(env.GRANARY_SEED_OTLP_ENDPOINT)) {
		endpoint = env.GRANARY_SEED_OTLP_ENDPOINT;
		const mode = env.GRANARY_SEED_OTLP_AUTH ?? 'none';
		const ref = { secretRef: SEED_SINK_TOKEN_REF };
		switch (mode) {
			case 'exe-peer':
				auth = { mode: 'exe-peer' };
				break;
			case 'exe-vm-token':
				auth = { mode: 'exe-vm-token', token: ref };
				break;
			case 'bearer':
				auth = { mode: 'bearer', token: ref };
				break;
			case 'basic':
				auth = { mode: 'basic', username: env.GRANARY_SEED_OTLP_USERNAME ?? 'granary', password: ref };
				break;
			default:
				auth = { mode: 'none' };
		}
		if (auth.mode !== 'none' && auth.mode !== 'exe-peer' && !secretExists(deps.db, SEED_SINK_TOKEN_REF)) {
			enabled = false;
			why = ` (disabled: secret ${SEED_SINK_TOKEN_REF} not found; set GRANARY_SEED_OTLP_TOKEN or add the token in /ops/secrets)`;
		}
	}
	if (!endpoint) return [];
	endpoint = endpoint.replace(/\/+$/, '');

	const body = {
		kind: 'otlp-http' as const,
		endpoint,
		auth,
		signals: exportOps ? (['traces', 'logs', 'metrics'] as const).slice() : (['traces', 'logs'] as const).slice(),
		volumeBudgetBytesPerMonth: 5 * GiB,
		maxBufferBytes: SINK_DEFAULTS.maxBufferBytes,
		flushIntervalMs,
		exportOps,
		// Link for humans (ADR 0154): the seed env wins; otherwise keep what the row has.
		...(env.GRANARY_SEED_OTLP_GRAFANA_URL ? { grafanaUrl: env.GRANARY_SEED_OTLP_GRAFANA_URL } : existing?.grafanaUrl ? { grafanaUrl: existing.grafanaUrl } : {})
	};
	if (existing) {
		const same = existing.endpoint === body.endpoint && JSON.stringify(existing.auth) === JSON.stringify(body.auth) && existing.exportOps === body.exportOps && existing.grafanaUrl === body.grafanaUrl;
		if (same && existing.enabled === enabled) return [];
		repo.upsert({ id: SEED_SINK_ID, name: existing.name, enabled, origin: 'seed', body, now: deps.now });
		return [`seed sink ${SEED_SINK_ID} updated → ${endpoint}${why}`];
	}
	repo.upsert({ id: SEED_SINK_ID, name: 'OTLP (seeded)', enabled, origin: 'seed', body, now: deps.now });
	// With GRANARY_SEED_OTLP_TOKEN set the token is seeded by the backups feature right
	// after this and the sink is re-seeded enabled (ADR 0150): no warning then.
	if (why && !env.GRANARY_SEED_OTLP_TOKEN) deps.log.warn(`ops telemetry: seed sink ${SEED_SINK_ID}${why}`);
	return [`seed sink ${SEED_SINK_ID} created → ${endpoint}${why}`];
}
