/**
 * The application-level write-ahead log in SQLite (ADR 0003, ADR 0033).
 *
 * `bun:sqlite`, WAL journal, `synchronous=FULL`. Every row read is validated
 * with the TypeBox row schemas from `$lib/schemas/wal`; JSON columns are
 * validated on write and read. Multi-step writes run in transactions.
 * Timestamps are epoch milliseconds.
 */
import { Database, type Statement } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IssueDoneData } from '../schemas/actors';
import {
	encodeOutboxPayload,
	encodeReplyTo,
	parseAllowedUserRow,
	parseInboxRow,
	parseOutboxRow,
	parseSessionRow,
	parseVerdictRow,
	type AllowedUserRow,
	type InboxRow,
	type InboxState,
	type OutboxPayload,
	type OutboxRow,
	type OutboxState,
	type ReplyTo,
	type SessionRow,
	type VerdictRow,
	type VerdictValue
} from '../schemas/wal';
import { secretsTableSql } from '../platform/secrets/store';

/** Schema migrations, applied in order; `PRAGMA user_version` records how many ran. */
const MIGRATIONS: string[] = [
	`CREATE TABLE IF NOT EXISTS inbox (
		delivery_id TEXT PRIMARY KEY,
		event TEXT NOT NULL,
		action TEXT,
		issue_key TEXT,
		payload TEXT NOT NULL,
		received_at INTEGER NOT NULL,
		state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','failed','ignored'))
	);
	CREATE INDEX IF NOT EXISTS inbox_state_received ON inbox(state, received_at);
	CREATE INDEX IF NOT EXISTS inbox_issue_key ON inbox(issue_key);
	CREATE TABLE IF NOT EXISTS outbox (
		effect_key TEXT PRIMARY KEY,
		issue_key TEXT NOT NULL,
		reply_to TEXT NOT NULL,
		payload TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','inflight','done','dead')),
		comment_id INTEGER,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER,
		last_error TEXT,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS outbox_state_next ON outbox(state, next_attempt_at);
	CREATE INDEX IF NOT EXISTS outbox_issue_key ON outbox(issue_key);
	CREATE TABLE IF NOT EXISTS verdicts (
		issue_key TEXT PRIMARY KEY,
		verdict TEXT NOT NULL CHECK (verdict IN ('allowed','closed','failed')),
		reason TEXT NOT NULL,
		decided_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS allowed_users (
		login TEXT PRIMARY KEY COLLATE NOCASE,
		added_by TEXT,
		added_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		login TEXT NOT NULL,
		avatar_url TEXT,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);`,
	/* 2: platform & first run (ADR 0157, 0158, 0161): admins, login links, audit log, secrets, settings */
	`CREATE TABLE IF NOT EXISTS admins (
		login TEXT PRIMARY KEY COLLATE NOCASE,
		added_by TEXT NOT NULL,
		added_at INTEGER NOT NULL,
		source TEXT NOT NULL CHECK (source IN ('seed','cli','ui'))
	);
	CREATE TABLE IF NOT EXISTS login_links (
		token_hash TEXT PRIMARY KEY,
		login TEXT NOT NULL COLLATE NOCASE,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		used_at INTEGER
	);
	CREATE INDEX IF NOT EXISTS login_links_expires ON login_links(expires_at);
	CREATE TABLE IF NOT EXISTS audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		actor TEXT NOT NULL,
		action TEXT NOT NULL,
		subject TEXT NOT NULL,
		detail TEXT
	);
	CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
	${secretsTableSql('secrets')}
	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		source TEXT NOT NULL CHECK (source IN ('seed','cli','ui')),
		updated_by TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);`
];

export interface InsertInbox {
	deliveryId: string;
	event: string;
	action: string | null;
	issueKey: string | null;
	payload: string;
	state: 'pending' | 'ignored';
}

export interface InsertOutbox {
	effectKey: string;
	issueKey: string;
	replyTo: ReplyTo;
	payload: OutboxPayload;
}

type Counts<K extends string> = Record<K, number>;

function zeroCounts<K extends string>(keys: readonly K[]): Counts<K> {
	return Object.fromEntries(keys.map((k) => [k, 0])) as Counts<K>;
}

export class Wal {
	readonly db: Database;
	readonly path: string;
	#stmts = new Map<string, Statement>();

	constructor(path: string) {
		this.path = path;
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec('PRAGMA journal_mode=WAL;');
		this.db.exec('PRAGMA synchronous=FULL;');
		this.db.exec('PRAGMA foreign_keys=ON;');
		this.db.exec('PRAGMA busy_timeout=5000;');
		this.migrate();
	}

	/** Idempotent: runs migrations past `user_version` in one transaction each. */
	migrate(): void {
		const { user_version } = this.db.query('PRAGMA user_version').get() as { user_version: number };
		for (let i = user_version; i < MIGRATIONS.length; i++) {
			this.db.transaction(() => {
				this.db.exec(MIGRATIONS[i]!);
				this.db.exec(`PRAGMA user_version = ${i + 1}`);
			})();
		}
	}

	close(): void {
		for (const s of this.#stmts.values()) s.finalize();
		this.#stmts.clear();
		this.db.close();
	}

	/** Cached prepared statement. */
	#q(sql: string): Statement {
		let s = this.#stmts.get(sql);
		if (!s) {
			s = this.db.prepare(sql);
			this.#stmts.set(sql, s);
		}
		return s;
	}

	tx<T>(fn: () => T): T {
		return this.db.transaction(fn)();
	}

	// -------------------------------------------------------------------------
	// inbox
	// -------------------------------------------------------------------------

	/** `INSERT OR IGNORE`; true when the row is new. */
	insertInbox(row: InsertInbox, now = Date.now()): boolean {
		const r = this.#q(
			`INSERT OR IGNORE INTO inbox (delivery_id, event, action, issue_key, payload, received_at, state)
			 VALUES ($id, $event, $action, $key, $payload, $at, $state)`
		).run({
			id: row.deliveryId,
			event: row.event,
			action: row.action,
			key: row.issueKey,
			payload: row.payload,
			at: now,
			state: row.state
		});
		return r.changes === 1;
	}

	getInbox(deliveryId: string): InboxRow | null {
		const r = this.#q('SELECT * FROM inbox WHERE delivery_id = $id').get({ id: deliveryId });
		return r ? parseInboxRow(r) : null;
	}

	/** Pending rows received at or before `receivedBefore`, oldest first. */
	pendingInbox(receivedBefore = Number.MAX_SAFE_INTEGER, limit = 1000): InboxRow[] {
		return this.#q(
			`SELECT * FROM inbox WHERE state = 'pending' AND received_at <= $before ORDER BY received_at LIMIT $limit`
		)
			.all({ before: receivedBefore, limit })
			.map(parseInboxRow);
	}

	setInboxState(deliveryId: string, state: InboxState, onlyIf: InboxState = 'pending'): boolean {
		return (
			this.#q('UPDATE inbox SET state = $state WHERE delivery_id = $id AND state = $only').run({
				state,
				id: deliveryId,
				only: onlyIf
			}).changes === 1
		);
	}

	listInbox(state: InboxState | undefined, limit: number, offset: number): InboxRow[] {
		const sql = state
			? `SELECT * FROM inbox WHERE state = $state ORDER BY received_at DESC, delivery_id DESC LIMIT $limit OFFSET $offset`
			: `SELECT * FROM inbox ORDER BY received_at DESC, delivery_id DESC LIMIT $limit OFFSET $offset`;
		const params = state ? { state, limit, offset } : { limit, offset };
		return this.#q(sql).all(params).map(parseInboxRow);
	}

	inboxForIssue(issueKey: string): InboxRow[] {
		return this.#q('SELECT * FROM inbox WHERE issue_key = $key ORDER BY received_at DESC, delivery_id DESC')
			.all({ key: issueKey })
			.map(parseInboxRow);
	}

	/** Newest `issues` inbox row per issue key, for a set of keys. */
	latestIssuesInbox(issueKey: string): InboxRow | null {
		const r = this.#q(
			`SELECT * FROM inbox WHERE issue_key = $key AND event = 'issues' ORDER BY (action = 'opened') DESC, received_at DESC LIMIT 1`
		).get({ key: issueKey });
		return r ? parseInboxRow(r) : null;
	}

	inboxCounts(): Counts<InboxState> {
		const out = zeroCounts<InboxState>(['pending', 'done', 'failed', 'ignored']);
		for (const r of this.#q('SELECT state, COUNT(*) AS n FROM inbox GROUP BY state').all() as {
			state: InboxState;
			n: number;
		}[])
			out[r.state] = r.n;
		return out;
	}

	// -------------------------------------------------------------------------
	// outbox
	// -------------------------------------------------------------------------

	/**
	 * `INSERT OR IGNORE` the effect row (state `pending`, due now). Returns the
	 * row as stored afterwards and whether this call inserted it.
	 */
	insertOutbox(row: InsertOutbox, now = Date.now()): { inserted: boolean; row: OutboxRow } {
		return this.tx(() => {
			const r = this.#q(
				`INSERT OR IGNORE INTO outbox (effect_key, issue_key, reply_to, payload, state, attempts, next_attempt_at, updated_at)
				 VALUES ($key, $issue, $reply, $payload, 'pending', 0, $now, $now)`
			).run({
				key: row.effectKey,
				issue: row.issueKey,
				reply: encodeReplyTo(row.replyTo),
				payload: encodeOutboxPayload(row.payload),
				now
			});
			const stored = this.getOutbox(row.effectKey);
			if (!stored) throw new Error(`outbox row ${row.effectKey} vanished`);
			return { inserted: r.changes === 1, row: stored };
		});
	}

	getOutbox(effectKey: string): OutboxRow | null {
		const r = this.#q('SELECT * FROM outbox WHERE effect_key = $key').get({ key: effectKey });
		return r ? parseOutboxRow(r) : null;
	}

	outboxForIssue(issueKey: string): OutboxRow | null {
		const r = this.#q('SELECT * FROM outbox WHERE issue_key = $key ORDER BY updated_at DESC LIMIT 1').get({
			key: issueKey
		});
		return r ? parseOutboxRow(r) : null;
	}

	/** Crash recovery at boot: `inflight` rows go back to `pending`, due now. */
	resetInflight(now = Date.now()): number {
		return this.#q(
			`UPDATE outbox SET state = 'pending', next_attempt_at = $now, updated_at = $now WHERE state = 'inflight'`
		).run({ now }).changes;
	}

	/**
	 * Claim up to `limit` due `pending` rows: they become `inflight` and their
	 * `attempts` is incremented, committed before any GitHub call.
	 */
	claimDue(limit: number, now = Date.now()): OutboxRow[] {
		if (limit <= 0) return [];
		return this.tx(() => {
			const due = this.#q(
				`SELECT effect_key FROM outbox WHERE state = 'pending' AND COALESCE(next_attempt_at, 0) <= $now
				 ORDER BY COALESCE(next_attempt_at, 0), effect_key LIMIT $limit`
			).all({ now, limit }) as { effect_key: string }[];
			const claimed: OutboxRow[] = [];
			for (const { effect_key } of due) {
				this.#q(
					`UPDATE outbox SET state = 'inflight', attempts = attempts + 1, updated_at = $now WHERE effect_key = $key`
				).run({ key: effect_key, now });
				const row = this.getOutbox(effect_key);
				if (row) claimed.push(row);
			}
			return claimed;
		});
	}

	setCommentId(effectKey: string, commentId: number, now = Date.now()): void {
		this.#q('UPDATE outbox SET comment_id = $id, updated_at = $now WHERE effect_key = $key').run({
			id: commentId,
			key: effectKey,
			now
		});
	}

	markOutboxDone(effectKey: string, now = Date.now()): void {
		this.#q(
			`UPDATE outbox SET state = 'done', next_attempt_at = NULL, last_error = NULL, updated_at = $now WHERE effect_key = $key`
		).run({ key: effectKey, now });
	}

	markOutboxRetry(effectKey: string, nextAttemptAt: number, error: string, now = Date.now()): void {
		this.#q(
			`UPDATE outbox SET state = 'pending', next_attempt_at = $next, last_error = $error, updated_at = $now WHERE effect_key = $key`
		).run({ key: effectKey, next: nextAttemptAt, error, now });
	}

	markOutboxDead(effectKey: string, error: string, now = Date.now()): void {
		this.#q(
			`UPDATE outbox SET state = 'dead', next_attempt_at = NULL, last_error = $error, updated_at = $now WHERE effect_key = $key`
		).run({ key: effectKey, error, now });
	}

	/**
	 * Operator retry (Backend.retryEffect): a `dead` row, or a `pending` one,
	 * goes to `pending`, attempts 0, due now. A `failed` verdict caused by the
	 * dead effect is removed in the same transaction so the issue actor can
	 * decide again when the relay replies (ADR 0041).
	 */
	retryOutbox(effectKey: string, now = Date.now()): OutboxRow {
		return this.tx(() => {
			const row = this.getOutbox(effectKey);
			if (!row) throw new Error('not-found');
			this.#q(
				`UPDATE outbox SET state = 'pending', attempts = 0, next_attempt_at = $now, updated_at = $now WHERE effect_key = $key`
			).run({ key: effectKey, now });
			this.#q(`DELETE FROM verdicts WHERE issue_key = $key AND verdict = 'failed'`).run({ key: row.issue_key });
			return this.getOutbox(effectKey)!;
		});
	}

	/** Earliest `next_attempt_at` of pending rows, or null. */
	nextOutboxDueAt(): number | null {
		const r = this.#q(`SELECT MIN(next_attempt_at) AS t FROM outbox WHERE state = 'pending'`).get() as {
			t: number | null;
		};
		return r.t ?? null;
	}

	listOutbox(state: OutboxState | undefined, limit: number, offset: number): OutboxRow[] {
		const sql = state
			? `SELECT * FROM outbox WHERE state = $state ORDER BY updated_at DESC, effect_key DESC LIMIT $limit OFFSET $offset`
			: `SELECT * FROM outbox ORDER BY updated_at DESC, effect_key DESC LIMIT $limit OFFSET $offset`;
		const params = state ? { state, limit, offset } : { limit, offset };
		return this.#q(sql).all(params).map(parseOutboxRow);
	}

	outboxCounts(): Counts<OutboxState> {
		const out = zeroCounts<OutboxState>(['pending', 'inflight', 'done', 'dead']);
		for (const r of this.#q('SELECT state, COUNT(*) AS n FROM outbox GROUP BY state').all() as {
			state: OutboxState;
			n: number;
		}[])
			out[r.state] = r.n;
		return out;
	}

	// -------------------------------------------------------------------------
	// verdicts
	// -------------------------------------------------------------------------

	getVerdict(issueKey: string): VerdictRow | null {
		const r = this.#q('SELECT * FROM verdicts WHERE issue_key = $key').get({ key: issueKey });
		return r ? parseVerdictRow(r) : null;
	}

	/**
	 * The `done` hook (ADR 0033): one transaction writes the verdict (not for
	 * `settled`) and marks the triggering inbox row `done`.
	 */
	recordDone(done: IssueDoneData, now = Date.now()): void {
		this.tx(() => {
			if (done.verdict !== 'settled') {
				this.#q(
					`INSERT OR REPLACE INTO verdicts (issue_key, verdict, reason, decided_at) VALUES ($key, $verdict, $reason, $now)`
				).run({ key: done.issueKey, verdict: done.verdict, reason: done.reason, now });
			}
			if (done.deliveryId) this.setInboxState(done.deliveryId, 'done');
		});
	}

	listVerdicts(verdict: VerdictValue | undefined, limit: number, offset: number): VerdictRow[] {
		const sql = verdict
			? `SELECT * FROM verdicts WHERE verdict = $verdict ORDER BY decided_at DESC, issue_key DESC LIMIT $limit OFFSET $offset`
			: `SELECT * FROM verdicts ORDER BY decided_at DESC, issue_key DESC LIMIT $limit OFFSET $offset`;
		const params = verdict ? { verdict, limit, offset } : { limit, offset };
		return this.#q(sql).all(params).map(parseVerdictRow);
	}

	verdictCounts(): Counts<VerdictValue> {
		const out = zeroCounts<VerdictValue>(['allowed', 'closed', 'failed']);
		for (const r of this.#q('SELECT verdict, COUNT(*) AS n FROM verdicts GROUP BY verdict').all() as {
			verdict: VerdictValue;
			n: number;
		}[])
			out[r.verdict] = r.n;
		return out;
	}

	// -------------------------------------------------------------------------
	// allowed_users
	// -------------------------------------------------------------------------

	listAllowedUsers(): AllowedUserRow[] {
		return this.#q('SELECT * FROM allowed_users ORDER BY login COLLATE NOCASE').all().map(parseAllowedUserRow);
	}

	getAllowedUser(login: string): AllowedUserRow | null {
		const r = this.#q('SELECT * FROM allowed_users WHERE login = $login').get({ login });
		return r ? parseAllowedUserRow(r) : null;
	}

	/** Lower-cased logins (the allowlist actor's binding / `allowlist.replace` data). */
	allowedLogins(): string[] {
		return this.listAllowedUsers().map((r) => r.login.toLowerCase());
	}

	/** Idempotent, case-insensitive. Returns the stored row and whether it was added. */
	addAllowedUser(login: string, addedBy: string | null, now = Date.now()): { row: AllowedUserRow; added: boolean } {
		return this.tx(() => {
			const r = this.#q(
				'INSERT OR IGNORE INTO allowed_users (login, added_by, added_at) VALUES ($login, $by, $now)'
			).run({ login, by: addedBy, now });
			return { row: this.getAllowedUser(login)!, added: r.changes === 1 };
		});
	}

	removeAllowedUser(login: string): boolean {
		return this.#q('DELETE FROM allowed_users WHERE login = $login').run({ login }).changes === 1;
	}

	allowedCount(): number {
		return (this.#q('SELECT COUNT(*) AS n FROM allowed_users').get() as { n: number }).n;
	}

	// -------------------------------------------------------------------------
	// sessions
	// -------------------------------------------------------------------------

	insertSession(row: SessionRow): void {
		this.#q(
			`INSERT INTO sessions (id, login, avatar_url, created_at, expires_at) VALUES ($id, $login, $avatar, $created, $expires)`
		).run({ id: row.id, login: row.login, avatar: row.avatar_url, created: row.created_at, expires: row.expires_at });
	}

	/** The session, or null when unknown or expired. */
	getSession(id: string, now = Date.now()): SessionRow | null {
		const r = this.#q('SELECT * FROM sessions WHERE id = $id AND expires_at > $now').get({ id, now });
		return r ? parseSessionRow(r) : null;
	}

	deleteSession(id: string): void {
		this.#q('DELETE FROM sessions WHERE id = $id').run({ id });
	}

	sweepSessions(now = Date.now()): number {
		return this.#q('DELETE FROM sessions WHERE expires_at <= $now').run({ now }).changes;
	}
}
