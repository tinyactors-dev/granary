/**
 * `telemetry_sinks` table access (ADR 0085, 0099, 0102, 0122). Owned by the
 * health/telemetry feature. Config JSON is validated with TypeBox on read
 * and write; rows that fail validation are skipped (and logged) rather than
 * crashing boot.
 */
import type { Database } from 'bun:sqlite';
import { check, issuesOf } from '../../schemas/standard';
import { TelemetrySinkConfig, type TelemetrySinkDraft } from '../schemas/sinks';
import { TelemetrySinkRow } from '../db/ddl';
import type { OpsLogger } from '../contract';

/** Defaults for fields the draft doesn't carry. */
export const SINK_DEFAULTS = {
	maxBufferBytes: 8 * 1024 ** 2,
	flushIntervalMs: 2_000
} as const;

type SinkBody = Omit<TelemetrySinkConfig, 'id' | 'name' | 'enabled' | 'origin' | 'version' | 'createdAt' | 'updatedAt' | 'lastTest'>;

export class SinksRepo {
	readonly #db: Database;
	readonly #log: OpsLogger;

	constructor(db: Database, log: OpsLogger) {
		this.#db = db;
		this.#log = log;
	}

	#toConfig(raw: unknown): TelemetrySinkConfig | null {
		if (!check(TelemetrySinkRow, raw)) return null;
		const row = raw as TelemetrySinkRow;
		let body: unknown;
		try {
			body = JSON.parse(row.config);
		} catch {
			this.#log.warn(`ops: telemetry sink ${row.id} has unreadable config JSON; skipped`);
			return null;
		}
		const cfg = {
			...(body as object),
			id: row.id,
			name: row.name,
			enabled: row.enabled === 1,
			origin: row.origin,
			version: row.version,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			lastTest:
				row.last_test_at === null
					? null
					: { at: row.last_test_at, ok: row.last_test_ok === 1, versionTested: row.last_test_version ?? 0 }
		};
		if (!check(TelemetrySinkConfig, cfg)) {
			const why = issuesOf(TelemetrySinkConfig, cfg)
				.slice(0, 3)
				.map((i) => `${i.path.join('.')}: ${i.message}`)
				.join('; ');
			this.#log.warn(`ops: telemetry sink ${row.id} config invalid (${why}); skipped`);
			return null;
		}
		return cfg as TelemetrySinkConfig;
	}

	list(): TelemetrySinkConfig[] {
		return this.#db
			.query('SELECT * FROM telemetry_sinks ORDER BY created_at, id')
			.all()
			.map((r) => this.#toConfig(r))
			.filter((c): c is TelemetrySinkConfig => c !== null);
	}

	get(id: string): TelemetrySinkConfig | null {
		const r = this.#db.query('SELECT * FROM telemetry_sinks WHERE id = $id').get({ id });
		return r ? this.#toConfig(r) : null;
	}

	exists(id: string): boolean {
		return !!this.#db.query('SELECT 1 FROM telemetry_sinks WHERE id = $id').get({ id });
	}

	/** Insert or update. Caller checks optimistic versions and test gating. */
	upsert(input: {
		id: string;
		name: string;
		enabled: boolean;
		origin: 'seed' | 'ui';
		body: SinkBody;
		now: number;
		lastTest?: { at: number; ok: boolean } | null;
	}): TelemetrySinkConfig {
		const existing = this.get(input.id);
		const version = existing ? existing.version + 1 : 1;
		const config = JSON.stringify(input.body);
		this.#db.transaction(() => {
			if (existing) {
				this.#db
					.query(
						`UPDATE telemetry_sinks SET name=$name, enabled=$enabled, origin=$origin, version=$version, config=$config, updated_at=$now WHERE id=$id`
					)
					.run({ id: input.id, name: input.name, enabled: input.enabled ? 1 : 0, origin: input.origin, version, config, now: input.now });
			} else {
				this.#db
					.query(
						`INSERT INTO telemetry_sinks (id, name, enabled, origin, version, config, created_at, updated_at)
						 VALUES ($id, $name, $enabled, $origin, 1, $config, $now, $now)`
					)
					.run({ id: input.id, name: input.name, enabled: input.enabled ? 1 : 0, origin: input.origin, config, now: input.now });
			}
			if (input.lastTest) this.recordTest(input.id, input.lastTest.ok, input.lastTest.at, version);
		})();
		const saved = this.get(input.id);
		if (!saved) throw new Error(`telemetry sink ${input.id} did not validate after save`);
		return saved;
	}

	recordTest(id: string, ok: boolean, at: number, version: number): void {
		this.#db
			.query('UPDATE telemetry_sinks SET last_test_at=$at, last_test_ok=$ok, last_test_version=$version WHERE id=$id')
			.run({ id, at, ok: ok ? 1 : 0, version });
	}

	delete(id: string): boolean {
		return this.#db.query('DELETE FROM telemetry_sinks WHERE id = $id').run({ id }).changes > 0;
	}

	/** Body fields from a draft, with defaults for what drafts don't carry. */
	static bodyFromDraft(draft: TelemetrySinkDraft, previous: TelemetrySinkConfig | null): SinkBody {
		return {
			kind: 'otlp-http',
			endpoint: draft.endpoint.replace(/\/+$/, ''),
			auth: draft.auth,
			signals: draft.signals,
			volumeBudgetBytesPerMonth: draft.volumeBudgetBytesPerMonth,
			maxBufferBytes: previous?.maxBufferBytes ?? SINK_DEFAULTS.maxBufferBytes,
			flushIntervalMs: previous?.flushIntervalMs ?? SINK_DEFAULTS.flushIntervalMs,
			...(draft.grafanaUrl ? { grafanaUrl: draft.grafanaUrl } : {}),
			...(draft.exportOps !== undefined ? { exportOps: draft.exportOps } : {})
		};
	}
}

/** Stable fingerprint of what a test connection proves (endpoint, auth, signals). */
export function sinkFingerprint(s: { endpoint: string; auth: unknown; signals: readonly string[] }): string {
	return JSON.stringify([s.endpoint.replace(/\/+$/, ''), s.auth, [...s.signals].sort()]);
}
