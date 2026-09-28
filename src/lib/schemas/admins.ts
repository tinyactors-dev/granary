/**
 * In-product admins, one-time login links, first-run setup state and the
 * audit log (ADR 0161). Rows live in granary.sqlite (E1 migrations).
 */
import { Type, type Static } from '@sinclair/typebox';
import { Login, Nullable } from './github';
import { EpochMs } from './wal';

const closed = { additionalProperties: false } as const;

export const AdminSource = Type.Union([Type.Literal('seed'), Type.Literal('cli'), Type.Literal('ui')]);
export type AdminSource = Static<typeof AdminSource>;

/** `admins` row (login is COLLATE NOCASE primary key). */
export const AdminRow = Type.Object(
	{ login: Login, added_by: Type.String(), added_at: EpochMs, source: AdminSource },
	closed
);
export type AdminRow = Static<typeof AdminRow>;

export const Admin = Type.Object(
	{ login: Login, addedBy: Type.String(), addedAt: EpochMs, source: AdminSource },
	closed
);
export type Admin = Static<typeof Admin>;

export const AddAdminInput = Type.Object({ login: Login }, closed);
export type AddAdminInput = Static<typeof AddAdminInput>;

export const AddAdminResult = Type.Object({ admin: Admin, added: Type.Boolean() }, closed);
export type AddAdminResult = Static<typeof AddAdminResult>;

export const RemoveAdminResult = Type.Object({ login: Login, removed: Type.Boolean() }, closed);
export type RemoveAdminResult = Static<typeof RemoveAdminResult>;

// ---------------------------------------------------------------------------
// Login links
// ---------------------------------------------------------------------------

export const LOGIN_LINK_DEFAULT_TTL_MS = 15 * 60_000;
export const LOGIN_LINK_MAX_TTL_MS = 24 * 3_600_000;
/** Path prefix; the full URL is `${ORIGIN}${LOGIN_LINK_PATH}/<token>`. */
export const LOGIN_LINK_PATH = '/auth/link';

/** `login_links` row; the token itself is never stored, only its SHA-256 (hex). */
export const LoginLinkRow = Type.Object(
	{
		token_hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
		login: Login,
		created_by: Type.String(),
		created_at: EpochMs,
		expires_at: EpochMs,
		used_at: Nullable(EpochMs)
	},
	closed
);
export type LoginLinkRow = Static<typeof LoginLinkRow>;

export const CreateLoginLinkInput = Type.Object(
	{
		login: Login,
		/** Milliseconds, 1 min … 24 h; default 15 min. */
		ttlMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: LOGIN_LINK_MAX_TTL_MS }))
	},
	closed
);
export type CreateLoginLinkInput = Static<typeof CreateLoginLinkInput>;

/** Lifecycle of a login link as listed in the UI (ADR 0170). */
export const LoginLinkState = Type.Union([Type.Literal('valid'), Type.Literal('used'), Type.Literal('expired'), Type.Literal('revoked')]);
export type LoginLinkState = Static<typeof LoginLinkState>;

/**
 * A login link without its token (ADR 0170): `id` is the first 16 hex chars
 * of the token's SHA-256 — enough to revoke it, useless to sign in with.
 */
export const LoginLinkSummary = Type.Object(
	{
		id: Type.String({ pattern: '^[0-9a-f]{16}$' }),
		login: Login,
		createdBy: Type.String(),
		createdAt: EpochMs,
		expiresAt: EpochMs,
		usedAt: Nullable(EpochMs),
		revokedAt: Nullable(EpochMs),
		state: LoginLinkState
	},
	closed
);
export type LoginLinkSummary = Static<typeof LoginLinkSummary>;

export const RevokeLoginLinkResult = Type.Object({ id: Type.String(), revoked: Type.Boolean() }, closed);
export type RevokeLoginLinkResult = Static<typeof RevokeLoginLinkResult>;

/** Shown once; the URL contains the only copy of the token. */
export const CreatedLoginLink = Type.Object({ url: Type.String(), login: Login, expiresAt: EpochMs }, closed);
export type CreatedLoginLink = Static<typeof CreatedLoginLink>;

// ---------------------------------------------------------------------------
// Setup state
// ---------------------------------------------------------------------------

/** `needs-github` until the GitHub connection mode is not `none` (ADR 0161). */
export const SetupState = Type.Union([Type.Literal('needs-github'), Type.Literal('ready')]);
export type SetupState = Static<typeof SetupState>;

export const SetupStatus = Type.Object(
	{
		state: SetupState,
		/** Public URL granary believes it has (ORIGIN); the webhook is `${origin}/webhook`. */
		origin: Nullable(Type.String()),
		masterKey: Type.Union([Type.Literal('ok'), Type.Literal('missing')]),
		adminCount: Type.Integer({ minimum: 0 })
	},
	closed
);
export type SetupStatus = Static<typeof SetupStatus>;

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const AuditAction = Type.Union([
	Type.Literal('admin.add'),
	Type.Literal('admin.remove'),
	Type.Literal('login-link.create'),
	Type.Literal('login-link.use'),
	Type.Literal('login-link.revoke'),
	Type.Literal('github.app.create'),
	Type.Literal('github.mode.set'),
	Type.Literal('github.disconnect'),
	Type.Literal('github.repo.enable'),
	Type.Literal('github.repo.disable'),
	Type.Literal('config.set')
]);
export type AuditAction = Static<typeof AuditAction>;

/** `audit_log` row (id INTEGER PRIMARY KEY AUTOINCREMENT). `detail` is JSON, never secrets. */
export const AuditRow = Type.Object(
	{ id: Type.Integer(), at: EpochMs, actor: Type.String(), action: AuditAction, subject: Type.String(), detail: Nullable(Type.String()) },
	closed
);
export type AuditRow = Static<typeof AuditRow>;

export const AuditEntry = Type.Object(
	{ id: Type.Integer(), at: EpochMs, actor: Type.String(), action: AuditAction, subject: Type.String(), detail: Type.Unknown() },
	closed
);
export type AuditEntry = Static<typeof AuditEntry>;
