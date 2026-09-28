/**
 * Admin socket protocol (ADR 0159): HTTP/1.1 over `<data>/admin.sock`,
 * `POST /v1/<command>` with a JSON body, JSON envelope back. Both ends
 * validate with these schemas. The server executes commands through the same
 * Backend/OpsBackend methods as the UI, with actor `admin-cli`.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { AddAdminResult, Admin, CreatedLoginLink, RemoveAdminResult, SetupStatus } from './admins';
import { GitHubStatus } from './github-app';
import { Login } from './github';

const closed = { additionalProperties: false } as const;

export const ADMIN_SOCKET_ACTOR = 'admin-cli';
export const ADMIN_SOCKET_PREFIX = '/v1/';

export const AdminErrorCode = Type.Union([
	Type.Literal('invalid'),
	Type.Literal('not-found'),
	Type.Literal('conflict'),
	Type.Literal('unavailable'),
	Type.Literal('internal')
]);
export type AdminErrorCode = Static<typeof AdminErrorCode>;

export const AdminError = Type.Object({ ok: Type.Literal(false), error: Type.Object({ code: AdminErrorCode, message: Type.String() }, closed) }, closed);
export type AdminError = Static<typeof AdminError>;

export const adminOk = <T extends TSchema>(result: T) => Type.Object({ ok: Type.Literal(true), result }, closed);

/** A dotted settings key, e.g. `github.mode` or `ops.budgets.egressGiB`. */
export const ConfigKey = Type.String({ pattern: '^[a-z][a-zA-Z0-9]*(\\.[a-zA-Z0-9-]+)*$', maxLength: 128 });

export const DoctorCheck = Type.Object(
	{ name: Type.String(), status: Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('fail')]), detail: Type.String() },
	closed
);
export type DoctorCheck = Static<typeof DoctorCheck>;

export const BackupRunRef = Type.Object({ planId: Type.String(), runId: Type.String() }, closed);

/** A blocklist entry on the wire (ADR 0260); mirrors `BlockedUser` in api.ts. */
export const BlockedUserWire = Type.Object(
	{
		login: Type.String(),
		note: Type.Union([Type.String(), Type.Null()]),
		expiresAt: Type.Union([Type.Number(), Type.Null()]),
		addedBy: Type.Union([Type.String(), Type.Null()]),
		addedAt: Type.Number(),
		active: Type.Boolean(),
		isAdmin: Type.Boolean()
	},
	closed
);

/**
 * Command → { request, response } schemas. Keys are the URL path after
 * `/v1/` (the CLI name with spaces replaced by `/`).
 */
export const ADMIN_COMMANDS = {
	'admin/add': { request: Type.Object({ login: Login }, closed), response: AddAdminResult },
	'admin/remove': { request: Type.Object({ login: Login }, closed), response: RemoveAdminResult },
	'admin/list': { request: Type.Object({}, closed), response: Type.Array(Admin) },
	'blocklist/add': {
		request: Type.Object(
			{
				login: Login,
				/** Milliseconds from now; null or absent = until removed. */
				forMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1000 }), Type.Null()])),
				note: Type.Optional(Type.String({ maxLength: 200 }))
			},
			closed
		),
		response: Type.Object({ user: BlockedUserWire, added: Type.Boolean() }, closed)
	},
	'blocklist/remove': { request: Type.Object({ login: Login }, closed), response: Type.Object({ login: Type.String(), removed: Type.Boolean() }, closed) },
	'blocklist/list': { request: Type.Object({}, closed), response: Type.Array(BlockedUserWire) },
	'login-link': {
		request: Type.Object({ login: Login, ttlMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 24 * 3_600_000 })) }, closed),
		response: CreatedLoginLink
	},
	'github/status': { request: Type.Object({}, closed), response: GitHubStatus },
	'github/setup-url': {
		request: Type.Object({ login: Type.Optional(Login) }, closed),
		response: Type.Object({ url: Type.String(), loginLink: Type.Optional(CreatedLoginLink) }, closed)
	},
	'config/get': { request: Type.Object({ key: ConfigKey }, closed), response: Type.Object({ key: ConfigKey, value: Type.Unknown(), source: Type.Union([Type.Literal('db'), Type.Literal('seed'), Type.Literal('default')]) }, closed) },
	'config/set': { request: Type.Object({ key: ConfigKey, value: Type.Unknown() }, closed), response: Type.Object({ key: ConfigKey, value: Type.Unknown() }, closed) },
	'config/seed': { request: Type.Object({}, closed), response: Type.Object({ applied: Type.Array(Type.String()) }, closed) },
	'backup/now': { request: Type.Object({ plan: Type.Optional(Type.String()) }, closed), response: Type.Object({ runs: Type.Array(BackupRunRef) }, closed) },
	'backup/list': {
		request: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, closed),
		response: Type.Array(Type.Object({ runId: Type.String(), planId: Type.String(), state: Type.String(), startedAt: Type.Number(), finishedAt: Type.Union([Type.Number(), Type.Null()]) }, closed))
	},
	doctor: { request: Type.Object({}, closed), response: Type.Object({ checks: Type.Array(DoctorCheck), setup: SetupStatus }, closed) }
} as const;

export type AdminCommandPath = keyof typeof ADMIN_COMMANDS;
export type AdminRequest<C extends AdminCommandPath> = Static<(typeof ADMIN_COMMANDS)[C]['request']>;
export type AdminResponse<C extends AdminCommandPath> = Static<(typeof ADMIN_COMMANDS)[C]['response']>;
