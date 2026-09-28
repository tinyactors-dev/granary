/**
 * Telemetry sink seeds (ADR 0102, 0110, 0122). One sink, id `seed-otlp`:
 *   - from `OPS_SEED_OTLP_ENDPOINT` + `OPS_SEED_OTLP_AUTH` (token modes use
 *     the secret `seed-otlp-token`, which the backups feature's seeds create
 *     from `OPS_SEED_OTLP_TOKEN`; without it the sink is created disabled);
 *   - else from the legacy `OTEL_EXPORTER_OTLP_ENDPOINT`, which keeps today's
 *     behaviour: granary's traces and logs only (`exportOps: false`),
 *     flushed every second, no auth.
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
	let exportOps = true;
	let flushIntervalMs: number = SINK_DEFAULTS.flushIntervalMs;
	let why = '';

	if (env.OPS_SEED_OTLP_ENDPOINT && URL_RE.test(env.OPS_SEED_OTLP_ENDPOINT)) {
		endpoint = env.OPS_SEED_OTLP_ENDPOINT;
		const mode = env.OPS_SEED_OTLP_AUTH ?? 'none';
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
				auth = { mode: 'basic', username: env.OPS_SEED_OTLP_USERNAME ?? 'granary', password: ref };
				break;
			default:
				auth = { mode: 'none' };
		}
		if (auth.mode !== 'none' && auth.mode !== 'exe-peer' && !secretExists(deps.db, SEED_SINK_TOKEN_REF)) {
			enabled = false;
			why = ` (disabled: secret ${SEED_SINK_TOKEN_REF} not found; set OPS_SEED_OTLP_TOKEN or add the token in /ops/secrets)`;
		}
	} else if (env.OTEL_EXPORTER_OTLP_ENDPOINT && URL_RE.test(env.OTEL_EXPORTER_OTLP_ENDPOINT)) {
		endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
		exportOps = false;
		flushIntervalMs = 1_000;
		if (env.OTEL_EXPORTER_OTLP_HEADERS) {
			// Header values are secrets; ops can't store them from here (the secret store belongs to backups).
			enabled = false;
			why = ' (disabled: OTEL_EXPORTER_OTLP_HEADERS is set; configure the header as a secret in /ops/telemetry)';
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
		exportOps
	};
	if (existing) {
		const same = existing.endpoint === body.endpoint && JSON.stringify(existing.auth) === JSON.stringify(body.auth) && existing.exportOps === body.exportOps;
		if (same && existing.enabled === enabled) return [];
		repo.upsert({ id: SEED_SINK_ID, name: existing.name, enabled, origin: 'seed', body, now: deps.now });
		return [`seed sink ${SEED_SINK_ID} updated → ${endpoint}${why}`];
	}
	repo.upsert({ id: SEED_SINK_ID, name: exportOps ? 'OTLP (seeded)' : 'OTLP (legacy OTEL_EXPORTER_OTLP_ENDPOINT)', enabled, origin: 'seed', body, now: deps.now });
	if (why) deps.log.warn(`ops telemetry: seed sink ${SEED_SINK_ID}${why}`);
	return [`seed sink ${SEED_SINK_ID} created → ${endpoint}${why}`];
}
