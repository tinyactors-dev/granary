/**
 * Persistence for the GitHub connection (ADR 0160): mode + small settings,
 * the app row, installations, repos and manifest nonces. Rows read back are
 * validated with the pinned TypeBox row schemas (`$lib/schemas/github-app`).
 */
import type { Database } from 'bun:sqlite';
import {
	GitHubAppRow,
	GitHubMode,
	InstallationRow,
	ManifestStateRow,
	RepoRow,
	type GitHubInstallation
} from '../../schemas/github-app';
import { check, parse } from '../../schemas/standard';
import { ensureGitHubSchema } from './schema';

export class GitHubStore {
	readonly db: Database;

	constructor(db: Database) {
		this.db = db;
		ensureGitHubSchema(db);
	}

	// -- configuration (platform `settings` kv, ADR 0157/0190) ---------------------

	getConfigValue(key: string): string | null {
		const row = this.db.query('SELECT value FROM settings WHERE key = ?1').get(key) as { value: string } | null;
		return row?.value ?? null;
	}

	/** `by` = 'seed' for seeds (source `seed`), else a login (source `ui`). */
	setConfigValue(key: string, value: string, by: string, now = Date.now()): void {
		this.db
			.query(
				`INSERT INTO settings (key, value, source, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source,
				   updated_by = excluded.updated_by, updated_at = excluded.updated_at`
			)
			.run(key, value, by === 'seed' ? 'seed' : 'ui', by, now);
	}

	// -- internal state (github_settings) ---------------------------------------------

	getSetting(key: string): string | null {
		const row = this.db.query('SELECT value FROM github_settings WHERE key = ?1').get(key) as { value: string } | null;
		return row?.value ?? null;
	}

	setSetting(key: string, value: string, by: string, now = Date.now()): void {
		this.db
			.query(
				`INSERT INTO github_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
			)
			.run(key, value, by, now);
	}

	getJson<T>(key: string, guard: (v: unknown) => v is T): T | null {
		const raw = this.getSetting(key);
		if (raw === null) return null;
		try {
			const v: unknown = JSON.parse(raw);
			return guard(v) ? v : null;
		} catch {
			return null;
		}
	}

	/** `null` = never configured (seeds may still decide). */
	getMode(key: string): GitHubMode | null {
		const v = this.getConfigValue(key);
		return v !== null && check(GitHubMode, v) ? v : null;
	}

	// -- app ------------------------------------------------------------------------

	getApp(): GitHubAppRow | null {
		const row = this.db.query('SELECT * FROM github_app ORDER BY created_at DESC LIMIT 1').get();
		return row ? parse(GitHubAppRow, row, 'github_app row') : null;
	}

	insertApp(row: GitHubAppRow): void {
		parse(GitHubAppRow, row, 'github_app row');
		this.db
			.query(
				`INSERT INTO github_app (app_id, slug, name, html_url, owner_login, client_id, created_by, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
			)
			.run(row.app_id, row.slug, row.name, row.html_url, row.owner_login, row.client_id, row.created_by, row.created_at);
	}

	// -- installations & repos --------------------------------------------------------

	listInstallations(): InstallationRow[] {
		return this.db
			.query('SELECT * FROM github_installations ORDER BY account_login')
			.all()
			.map((r) => parse(InstallationRow, r, 'github_installations row'));
	}

	upsertInstallation(inst: GitHubInstallation, now = Date.now()): void {
		this.db
			.query(
				`INSERT INTO github_installations (installation_id, account_login, account_type, repository_selection, suspended, synced_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
				 ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type,
				   repository_selection = excluded.repository_selection, suspended = excluded.suspended, synced_at = excluded.synced_at`
			)
			.run(inst.id, inst.account.login, inst.account.type, inst.repository_selection, inst.suspended_at ? 1 : 0, now);
	}

	deleteInstallation(installationId: number): void {
		this.db.transaction(() => {
			// Repos keep their `enabled` choice but lose the installation link.
			this.db.query('UPDATE github_repos SET installation_id = NULL WHERE installation_id = ?1').run(installationId);
			this.db.query('DELETE FROM github_installations WHERE installation_id = ?1').run(installationId);
		})();
	}

	setInstallationSuspended(installationId: number, suspended: boolean, now = Date.now()): void {
		this.db
			.query('UPDATE github_installations SET suspended = ?2, synced_at = ?3 WHERE installation_id = ?1')
			.run(installationId, suspended ? 1 : 0, now);
	}

	listRepos(): RepoRow[] {
		return this.db
			.query('SELECT * FROM github_repos ORDER BY full_name')
			.all()
			.map((r) => parse(RepoRow, r, 'github_repos row'));
	}

	getRepo(repoId: number): RepoRow | null {
		const row = this.db.query('SELECT * FROM github_repos WHERE repo_id = ?1').get(repoId);
		return row ? parse(RepoRow, row, 'github_repos row') : null;
	}

	getRepoByName(fullName: string): RepoRow | null {
		const row = this.db.query('SELECT * FROM github_repos WHERE full_name = ?1 COLLATE NOCASE').get(fullName);
		return row ? parse(RepoRow, row, 'github_repos row') : null;
	}

	/** Insert or re-link a repo; an existing `enabled` choice is kept. */
	upsertRepo(repoId: number, fullName: string, installationId: number | null, now = Date.now()): void {
		this.db
			.query(
				`INSERT INTO github_repos (repo_id, full_name, installation_id, enabled, updated_by, updated_at)
				 VALUES (?1, ?2, ?3, 1, NULL, ?4)
				 ON CONFLICT(repo_id) DO UPDATE SET full_name = excluded.full_name, installation_id = excluded.installation_id,
				   updated_at = excluded.updated_at`
			)
			.run(repoId, fullName, installationId, now);
	}

	/** Detach repos of an installation that are no longer in `keep`. */
	detachReposExcept(installationId: number, keep: number[], now = Date.now()): void {
		const rows = this.db.query('SELECT repo_id FROM github_repos WHERE installation_id = ?1').all(installationId) as { repo_id: number }[];
		const keepSet = new Set(keep);
		for (const { repo_id } of rows) {
			if (!keepSet.has(repo_id)) {
				this.db.query('UPDATE github_repos SET installation_id = NULL, updated_at = ?2 WHERE repo_id = ?1').run(repo_id, now);
			}
		}
	}

	detachRepo(repoId: number, now = Date.now()): void {
		this.db.query('UPDATE github_repos SET installation_id = NULL, updated_at = ?2 WHERE repo_id = ?1').run(repoId, now);
	}

	setRepoEnabled(repoId: number, enabled: boolean, by: string, now = Date.now()): RepoRow | null {
		const r = this.db
			.query('UPDATE github_repos SET enabled = ?2, updated_by = ?3, updated_at = ?4 WHERE repo_id = ?1')
			.run(repoId, enabled ? 1 : 0, by, now);
		return r.changes ? this.getRepo(repoId) : null;
	}

	// -- manifest nonces ------------------------------------------------------------

	insertManifestState(row: ManifestStateRow): void {
		parse(ManifestStateRow, row, 'manifest_states row');
		this.db
			.query('INSERT INTO manifest_states (state, created_by, created_at, expires_at, used_at) VALUES (?1, ?2, ?3, ?4, NULL)')
			.run(row.state, row.created_by, row.created_at, row.expires_at);
		// Old nonces are useless after a day.
		this.db.query('DELETE FROM manifest_states WHERE expires_at < ?1').run(row.created_at - 86_400_000);
	}

	/** Mark a nonce used; the row as it was, or null when unknown. */
	consumeManifestState(state: string, now = Date.now()): ManifestStateRow | null {
		return this.db.transaction(() => {
			const row = this.db.query('SELECT * FROM manifest_states WHERE state = ?1').get(state);
			if (!row) return null;
			const parsed = parse(ManifestStateRow, row, 'manifest_states row');
			if (parsed.used_at === null) this.db.query('UPDATE manifest_states SET used_at = ?2 WHERE state = ?1').run(state, now);
			return parsed;
		})();
	}
}
