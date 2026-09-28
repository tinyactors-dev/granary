/**
 * `granary config get|set|seed` (ADR 0159): in-product settings by dotted
 * key. Keys owned by the GitHub connection (`GITHUB_SETTING_KEYS`, e.g.
 * `github.mode`) live in its `github_settings` table (ADR 0190); every other
 * key lives in the `settings` kv (ADR 0157). No SvelteKit imports: the CLI's
 * offline mode uses this directly.
 */
import type { Database } from 'bun:sqlite';
import { GITHUB_SETTING_KEYS, GitHubMode } from '../schemas/github-app';
import { check } from '../schemas/standard';
import { AdminStore, AdminStoreError, type SettingSource } from './admins';

const GITHUB_KEYS = new Set<string>(Object.values(GITHUB_SETTING_KEYS));

export interface ConfigGetResult {
	key: string;
	value: unknown;
	source: 'db' | 'seed' | 'default';
}

function githubTable(db: Database): boolean {
	return !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'github_settings'`).get();
}

export function configGet(db: Database, key: string): ConfigGetResult {
	if (GITHUB_KEYS.has(key)) {
		if (!githubTable(db)) return { key, value: null, source: 'default' };
		const r = db.query('SELECT value, updated_by FROM github_settings WHERE key = ?').get(key) as { value: string; updated_by: string | null } | null;
		if (!r) return { key, value: null, source: 'default' };
		let value: unknown = r.value;
		if (key !== GITHUB_SETTING_KEYS.mode) {
			try {
				value = JSON.parse(r.value);
			} catch {
				/* plain string */
			}
		}
		return { key, value, source: r.updated_by === 'seed' ? 'seed' : 'db' };
	}
	const s = new AdminStore(db).getSetting(key);
	return s ? { key, value: s.value, source: s.source === 'seed' ? 'seed' : 'db' } : { key, value: null, source: 'default' };
}

export function configSet(db: Database, key: string, value: unknown, source: SettingSource, by: string): { key: string; value: unknown } {
	const admins = new AdminStore(db);
	if (GITHUB_KEYS.has(key)) {
		if (key === GITHUB_SETTING_KEYS.mode && !check(GitHubMode, value))
			throw new AdminStoreError('invalid', `github.mode must be one of none, app, token (got ${JSON.stringify(value)})`);
		if (!githubTable(db)) throw new AdminStoreError('invalid', `${key} is stored by the GitHub connection; start the server once so its tables exist`);
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		db.transaction(() => {
			db.query(
				`INSERT INTO github_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
			).run(key, text, by, Date.now());
			admins.audit(by, key === GITHUB_SETTING_KEYS.mode ? 'github.mode.set' : 'config.set', key, key === GITHUB_SETTING_KEYS.mode ? { mode: value } : null);
		})();
		return { key, value };
	}
	const s = admins.setSetting(key, value, source, by);
	return { key: s.key, value: s.value };
}

/** Parse a CLI value: JSON when it parses (numbers, booleans, objects), else the raw string. */
export function parseConfigValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
