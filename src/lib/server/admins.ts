/**
 * In-product admins, one-time login links, the audit log and the settings kv
 * (ADR 0157, 0161). Plain `bun:sqlite` over granary.sqlite — no SvelteKit
 * imports — so the running server (RealBackend, admin socket) and the CLI's
 * offline mode (`granary admin add` with no server running) share it.
 */
import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import {
	LOGIN_LINK_DEFAULT_TTL_MS,
	LOGIN_LINK_MAX_TTL_MS,
	LOGIN_LINK_PATH,
	type AddAdminResult,
	type Admin,
	type AdminRow,
	type AdminSource,
	type AuditAction,
	type AuditEntry,
	type AuditRow,
	type CreatedLoginLink,
	type LoginLinkState,
	type LoginLinkSummary,
	type RevokeLoginLinkResult,
	type RemoveAdminResult,
	type SetupState
} from '../schemas/admins';
import { Login } from '../schemas/github';
import { check } from '../schemas/standard';

export type AdminStoreErrorCode = 'invalid' | 'not-found' | 'conflict';

export class AdminStoreError extends Error {
	readonly code: AdminStoreErrorCode;
	constructor(code: AdminStoreErrorCode, message: string) {
		super(message);
		this.name = 'AdminStoreError';
		this.code = code;
	}
}

export type SettingSource = 'seed' | 'cli' | 'ui';

export interface SettingValue {
	key: string;
	value: unknown;
	source: SettingSource;
	updatedBy: string;
	updatedAt: number;
}


const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** `github.mode` from the platform settings kv (ADR 0220), or null when never set. */
export function readGitHubMode(db: Database): string | null {
	try {
		const row = db.query(`SELECT value FROM settings WHERE key = 'github.mode'`).get() as { value: string } | null;
		if (!row) return null;
		try {
			const v: unknown = JSON.parse(row.value);
			return typeof v === 'string' ? v : null;
		} catch {
			return row.value;
		}
	} catch {
		return null;
	}
}

export class AdminStore {
	readonly db: Database;
	readonly #now: () => number;

	constructor(db: Database, opts: { now?: () => number } = {}) {
		this.db = db;
		this.#now = opts.now ?? Date.now;
	}

	// -- admins -------------------------------------------------------------------------

	static validLogin(login: string): boolean {
		return check(Login, login);
	}

	#requireLogin(login: string): string {
		const l = login.trim();
		if (!AdminStore.validLogin(l)) throw new AdminStoreError('invalid', `not a valid GitHub login: ${JSON.stringify(login)}`);
		return l;
	}

	listAdmins(): Admin[] {
		const rows = this.db.query('SELECT login, added_by, added_at, source FROM admins ORDER BY login COLLATE NOCASE').all() as AdminRow[];
		return rows.map((r) => ({ login: r.login, addedBy: r.added_by, addedAt: r.added_at, source: r.source }));
	}

	adminCount(): number {
		return (this.db.query('SELECT count(*) AS n FROM admins').get() as { n: number }).n;
	}

	isAdmin(login: string): boolean {
		return !!this.db.query('SELECT 1 FROM admins WHERE login = ?').get(login.trim());
	}

	getAdmin(login: string): Admin | null {
		const r = this.db.query('SELECT login, added_by, added_at, source FROM admins WHERE login = ?').get(login.trim()) as AdminRow | null;
		return r ? { login: r.login, addedBy: r.added_by, addedAt: r.added_at, source: r.source } : null;
	}

	/** Idempotent: an existing admin is returned with `added: false`. */
	addAdmin(login: string, addedBy: string, source: AdminSource): AddAdminResult {
		const l = this.#requireLogin(login);
		const existing = this.getAdmin(l);
		if (existing) return { admin: existing, added: false };
		const now = this.#now();
		this.db.transaction(() => {
			this.db.query('INSERT INTO admins (login, added_by, added_at, source) VALUES (?,?,?,?)').run(l, addedBy, now, source);
			this.audit(addedBy, 'admin.add', l, { source });
		})();
		return { admin: this.getAdmin(l)!, added: true };
	}

	/** `conflict` when it would remove the last admin; `removed: false` when not an admin. */
	removeAdmin(login: string, removedBy: string): RemoveAdminResult {
		const l = this.#requireLogin(login);
		const existing = this.getAdmin(l);
		if (!existing) return { login: l, removed: false };
		let removed = false;
		this.db.transaction(() => {
			if (this.adminCount() <= 1) throw new AdminStoreError('conflict', `${existing.login} is the last admin and cannot be removed`);
			this.db.query('DELETE FROM admins WHERE login = ?').run(l);
			this.audit(removedBy, 'admin.remove', existing.login, null);
			removed = true;
		})();
		return { login: existing.login, removed };
	}

	/** Insert seed admins that don't exist yet (never removes). Returns logins added. */
	seedAdmins(logins: readonly string[]): string[] {
		const added: string[] = [];
		for (const raw of logins) {
			const l = raw.trim();
			if (!l || !AdminStore.validLogin(l)) continue;
			if (this.addAdmin(l, 'seed', 'seed').added) added.push(l);
		}
		return added;
	}

	// -- login links --------------------------------------------------------------------

	/**
	 * Create a one-time sign-in link for an admin (ADR 0161). The token is only
	 * in the returned URL; the database keeps its SHA-256.
	 */
	createLoginLink(input: { login: string; ttlMs?: number }, createdBy: string, origin: string): CreatedLoginLink {
		const l = this.#requireLogin(input.login);
		const admin = this.getAdmin(l);
		if (!admin) throw new AdminStoreError('invalid', `${l} is not an admin (add it with \`granary admin add ${l}\`)`);
		const ttl = input.ttlMs ?? LOGIN_LINK_DEFAULT_TTL_MS;
		if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > LOGIN_LINK_MAX_TTL_MS) throw new AdminStoreError('invalid', 'ttl must be between 1 minute and 24 hours');
		const token = randomBytes(32).toString('base64url');
		const now = this.#now();
		const expiresAt = now + ttl;
		this.db.transaction(() => {
			this.db.query('DELETE FROM login_links WHERE expires_at < ?').run(now - 7 * 86_400_000);
			this.db
				.query('INSERT INTO login_links (token_hash, login, created_by, created_at, expires_at, used_at) VALUES (?,?,?,?,?,NULL)')
				.run(sha256Hex(token), admin.login, createdBy, now, expiresAt);
			this.audit(createdBy, 'login-link.create', admin.login, { expiresAt });
		})();
		return { url: `${trimSlash(origin)}${LOGIN_LINK_PATH}/${token}`, login: admin.login, expiresAt };
	}

	/** Look at a token without consuming it (the confirm page). */
	peekLoginLink(token: string): { state: LoginLinkState | 'unknown'; login: string | null; expiresAt: number | null } {
		if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { state: 'unknown', login: null, expiresAt: null };
		const r = this.db.query('SELECT login, expires_at, used_at, revoked_at FROM login_links WHERE token_hash = ?').get(sha256Hex(token)) as
			| { login: string; expires_at: number; used_at: number | null; revoked_at: number | null }
			| null;
		if (!r) return { state: 'unknown', login: null, expiresAt: null };
		return { state: this.#linkState(r), login: r.login, expiresAt: r.expires_at };
	}

	#linkState(r: { expires_at: number; used_at: number | null; revoked_at: number | null }): LoginLinkState {
		return r.revoked_at !== null ? 'revoked' : r.used_at !== null ? 'used' : r.expires_at <= this.#now() ? 'expired' : 'valid';
	}

	/** Newest first; tokens are never returned (ADR 0170). */
	listLoginLinks(limit = 50): LoginLinkSummary[] {
		const rows = this.db
			.query('SELECT token_hash, login, created_by, created_at, expires_at, used_at, revoked_at FROM login_links ORDER BY created_at DESC LIMIT ?')
			.all(Math.max(1, Math.min(limit, 500))) as { token_hash: string; login: string; created_by: string; created_at: number; expires_at: number; used_at: number | null; revoked_at: number | null }[];
		return rows.map((r) => ({
			id: r.token_hash.slice(0, 16),
			login: r.login,
			createdBy: r.created_by,
			createdAt: r.created_at,
			expiresAt: r.expires_at,
			usedAt: r.used_at,
			revokedAt: r.revoked_at,
			state: this.#linkState(r)
		}));
	}

	/** Revoke an unused link by id (hash prefix). `revoked: false` when already used, expired or revoked. */
	revokeLoginLink(id: string, revokedBy: string): RevokeLoginLinkResult {
		if (!/^[0-9a-f]{16}$/.test(id)) throw new AdminStoreError('invalid', 'a login link id is 16 hex characters');
		const r = this.db.query('SELECT token_hash, login FROM login_links WHERE substr(token_hash, 1, 16) = ?').all(id) as { token_hash: string; login: string }[];
		if (r.length === 0) throw new AdminStoreError('not-found', `login link ${id} not found`);
		const now = this.#now();
		let revoked = false;
		this.db.transaction(() => {
			const changes = this.db
				.query('UPDATE login_links SET revoked_at = ? WHERE substr(token_hash, 1, 16) = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
				.run(now, id, now).changes;
			revoked = changes > 0;
			if (revoked) this.audit(revokedBy, 'login-link.revoke', r[0]!.login, { id });
		})();
		return { id, revoked };
	}

	/**
	 * Atomically consume a token: single use, unexpired, and the login still an
	 * admin. Returns the login, or null.
	 */
	consumeLoginLink(token: string): string | null {
		if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
		const now = this.#now();
		let login: string | null = null;
		this.db.transaction(() => {
			const r = this.db
				.query('UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING login')
				.get(now, sha256Hex(token), now) as { login: string } | null;
			if (!r) return;
			if (!this.isAdmin(r.login)) return;
			login = this.getAdmin(r.login)!.login;
			this.audit(login, 'login-link.use', login, null);
		})();
		return login;
	}

	// -- audit ----------------------------------------------------------------------------

	audit(actor: string, action: AuditAction, subject: string, detail: Record<string, unknown> | null): void {
		this.db
			.query('INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?,?,?,?,?)')
			.run(this.#now(), actor, action, subject, detail ? JSON.stringify(detail) : null);
	}

	listAudit(limit: number): AuditEntry[] {
		const rows = this.db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(limit, 1000))) as AuditRow[];
		return rows.map((r) => {
			let detail: unknown = null;
			if (r.detail) {
				try {
					detail = JSON.parse(r.detail);
				} catch {
					detail = r.detail;
				}
			}
			return { id: r.id, at: r.at, actor: r.actor, action: r.action, subject: r.subject, detail };
		});
	}

	// -- settings kv (`granary config get|set`) -------------------------------------------

	getSetting(key: string): SettingValue | null {
		const r = this.db.query('SELECT key, value, source, updated_by, updated_at FROM settings WHERE key = ?').get(key) as
			| { key: string; value: string; source: SettingSource; updated_by: string; updated_at: number }
			| null;
		if (!r) return null;
		let value: unknown = r.value;
		try {
			value = JSON.parse(r.value);
		} catch {
			/* stored as plain text */
		}
		return { key: r.key, value, source: r.source, updatedBy: r.updated_by, updatedAt: r.updated_at };
	}

	setSetting(key: string, value: unknown, source: SettingSource, by: string, auditAs: { action: 'config.set' | 'github.mode.set'; details: Record<string, unknown> | null } = { action: 'config.set', details: null }): SettingValue {
		const now = this.#now();
		this.db.transaction(() => {
			this.db
				.query(
					`INSERT INTO settings (key, value, source, updated_by, updated_at) VALUES (?,?,?,?,?)
					 ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
				)
				.run(key, JSON.stringify(value), source, by, now);
			if (source !== 'seed') this.audit(by, auditAs.action, key, auditAs.details);
		})();
		return this.getSetting(key)!;
	}

	/** Seed a setting only when absent (never overwrites edits). */
	seedSetting(key: string, value: unknown): boolean {
		if (this.getSetting(key)) return false;
		this.setSetting(key, value, 'seed', 'seed');
		return true;
	}

	listSettings(): SettingValue[] {
		return (this.db.query('SELECT key FROM settings ORDER BY key').all() as { key: string }[]).map((r) => this.getSetting(r.key)!);
	}

	// -- setup state ----------------------------------------------------------------------

	/**
	 * `needs-github` until a GitHub connection mode other than `none` exists
	 * (ADR 0161). The connection's boot seeds always write `github.mode`
	 * (ADR 0220), so no env inference is needed here.
	 */
	setupState(): SetupState {
		const mode = readGitHubMode(this.db);
		return mode === 'app' || mode === 'token' ? 'ready' : 'needs-github';
	}
}
