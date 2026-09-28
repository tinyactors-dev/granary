/**
 * `granary config get|set|seed` (ADR 0159): in-product settings by dotted
 * key, all in the platform `settings` kv (ADR 0157), JSON-encoded. That
 * includes the GitHub connection's `github.mode` and token-mode OAuth
 * client id (ADR 0220: one source of truth). The connection's internal
 * state (`github.catchup.checkpoint`, …) lives in `github_settings` and is
 * read-only here. No SvelteKit imports: the CLI's offline mode uses this.
 */
import type { Database } from 'bun:sqlite';
import { GITHUB_SETTING_KEYS, GitHubMode } from '../schemas/github-app';
import { check } from '../schemas/standard';
import { AdminStore, AdminStoreError, type SettingSource } from './admins';

/** Internal GitHub connection state (github_settings): readable, not settable. */
const GITHUB_INTERNAL_KEYS = new Set<string>([GITHUB_SETTING_KEYS.catchupCheckpoint]);

export interface ConfigGetResult {
	key: string;
	value: unknown;
	source: 'db' | 'seed' | 'default';
}

function githubTable(db: Database): boolean {
	return !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'github_settings'`).get();
}

export function configGet(db: Database, key: string): ConfigGetResult {
	if (GITHUB_INTERNAL_KEYS.has(key)) {
		if (!githubTable(db)) return { key, value: null, source: 'default' };
		const r = db.query('SELECT value FROM github_settings WHERE key = ?').get(key) as { value: string } | null;
		if (!r) return { key, value: null, source: 'default' };
		let value: unknown = r.value;
		try {
			value = JSON.parse(r.value);
		} catch {
			/* plain string */
		}
		return { key, value, source: 'db' };
	}
	const s = new AdminStore(db).getSetting(key);
	return s ? { key, value: s.value, source: s.source === 'seed' ? 'seed' : 'db' } : { key, value: null, source: 'default' };
}

export function configSet(db: Database, key: string, value: unknown, source: SettingSource, by: string): { key: string; value: unknown } {
	const admins = new AdminStore(db);
	if (GITHUB_INTERNAL_KEYS.has(key)) throw new AdminStoreError('invalid', `${key} is internal state of the GitHub connection and cannot be set`);
	if (key === GITHUB_SETTING_KEYS.mode) {
		if (!check(GitHubMode, value)) throw new AdminStoreError('invalid', `github.mode must be one of none, app, token (got ${JSON.stringify(value)})`);
		const s = admins.setSetting(key, value, source, by, { action: 'github.mode.set', details: { mode: value } });
		return { key: s.key, value: s.value };
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
