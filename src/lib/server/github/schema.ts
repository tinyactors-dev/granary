/**
 * granary.sqlite tables owned by the GitHub connection (ADR 0160, 0190).
 *
 * Applied idempotently at boot with `CREATE TABLE IF NOT EXISTS`, separately
 * from the WAL's ordered `user_version` migrations, so this fork's tables and
 * the platform fork's migrations (admins, login links, secrets, settings)
 * never race for the same migration index (ADR 0190). Configuration
 * (`github.mode`, the token-mode OAuth client id) lives in the platform
 * `settings` kv so `granary config set` can change it; `github_settings`
 * holds internal state (catch-up checkpoint/status). Future changes to
 * these tables append a new step to GITHUB_SCHEMA_STEPS; the applied step
 * count lives in `github_settings` under `schema.steps`.
 */
import type { Database } from 'bun:sqlite';

/**
 * The platform `settings` kv (ADR 0157, created by the WAL migrations of the
 * platform fork). Repeated here with the identical definition so this module
 * also works on a database where it does not exist yet.
 */
const PLATFORM_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		source TEXT NOT NULL CHECK (source IN ('seed','cli','ui')),
		updated_by TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);`;

const GITHUB_SCHEMA_STEPS: string[] = [
	`CREATE TABLE IF NOT EXISTS github_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_by TEXT,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS github_app (
		app_id INTEGER PRIMARY KEY,
		slug TEXT NOT NULL,
		name TEXT NOT NULL,
		html_url TEXT NOT NULL,
		owner_login TEXT NOT NULL,
		client_id TEXT NOT NULL,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS github_installations (
		installation_id INTEGER PRIMARY KEY,
		account_login TEXT NOT NULL,
		account_type TEXT NOT NULL,
		repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all','selected')),
		suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
		synced_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS github_repos (
		repo_id INTEGER PRIMARY KEY,
		full_name TEXT NOT NULL,
		installation_id INTEGER,
		enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
		updated_by TEXT,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS github_repos_installation ON github_repos(installation_id);
	CREATE TABLE IF NOT EXISTS manifest_states (
		state TEXT PRIMARY KEY,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		used_at INTEGER
	);`
];

export function ensureGitHubSchema(db: Database): void {
	db.transaction(() => {
		db.exec(PLATFORM_SETTINGS_DDL);
		db.exec(GITHUB_SCHEMA_STEPS[0]!);
		const row = db.query(`SELECT value FROM github_settings WHERE key = 'schema.steps'`).get() as { value: string } | null;
		const applied = row ? Number(row.value) : 1;
		for (let i = Math.max(1, applied); i < GITHUB_SCHEMA_STEPS.length; i++) db.exec(GITHUB_SCHEMA_STEPS[i]!);
		db.query(
			`INSERT INTO github_settings (key, value, updated_by, updated_at) VALUES ('schema.steps', ?1, 'migrate', ?2)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		).run(String(GITHUB_SCHEMA_STEPS.length), Date.now());
	})();
}
