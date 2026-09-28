/**
 * The in-product GitHub connection (ADR 0160, 0162, 0164): connection mode,
 * the app manifest we send, GitHub's manifest-conversion response, stored
 * app / installation / repo rows, installation tokens, the app's hook
 * delivery log, and the DTOs the settings UI and CLI use.
 *
 * Inbound GitHub shapes allow additional properties (GitHub sends more);
 * our own rows and DTOs are closed. Timestamps are epoch ms unless noted.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Login, Nullable } from './github';
import { EpochMs } from './wal';

const closed = { additionalProperties: false } as const;
const open = { additionalProperties: true } as const;

// ---------------------------------------------------------------------------
// Mode and secret refs
// ---------------------------------------------------------------------------

/** `none` = setup required; `app` = connected as a GitHub App (the only way granary talks to GitHub, ADR 0230). */
export const GitHubMode = Type.Union([Type.Literal('none'), Type.Literal('app')]);
export type GitHubMode = Static<typeof GitHubMode>;

/** Fixed ids in the platform secret store (ADR 0158). */
export const GITHUB_SECRET_REFS = {
	appPrivateKey: 'github-app-private-key',
	appWebhookSecret: 'github-app-webhook-secret',
	appClientSecret: 'github-app-client-secret'
} as const;

/** Settings keys (granary.sqlite `settings` kv) owned by the GitHub connection. */
export const GITHUB_SETTING_KEYS = {
	mode: 'github.mode',
	catchupCheckpoint: 'github.catchup.checkpoint'
} as const;

// ---------------------------------------------------------------------------
// Manifest flow (ADR 0160)
// ---------------------------------------------------------------------------

/** The manifest POSTed to `{GRANARY_GITHUB_WEB_URL}/settings/apps/new?state=…`. */
export const GitHubAppManifest = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 34 }),
		url: Type.String(),
		hook_attributes: Type.Object({ url: Type.String(), active: Type.Optional(Type.Boolean()) }, closed),
		redirect_url: Type.String(),
		callback_urls: Type.Array(Type.String(), { minItems: 1 }),
		setup_url: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		public: Type.Boolean(),
		request_oauth_on_install: Type.Optional(Type.Boolean()),
		setup_on_update: Type.Optional(Type.Boolean()),
		default_permissions: Type.Record(Type.String(), Type.Union([Type.Literal('read'), Type.Literal('write')])),
		default_events: Type.Array(Type.String())
	},
	closed
);
export type GitHubAppManifest = Static<typeof GitHubAppManifest>;

export const GITHUB_APP_PERMISSIONS = { issues: 'write', pull_requests: 'write', metadata: 'read' } as const;
export const GITHUB_APP_EVENTS = ['issues', 'pull_request'] as const;
/** Permission and event gating pull requests needs (ADR 0281). */
export const PR_PERMISSION = 'pull_requests';
export const PR_EVENT = 'pull_request';
/** Webhook events granary accepts besides `issues` (installation sync, ADR 0160). */
export const GITHUB_APP_LIFECYCLE_EVENTS = ['installation', 'installation_repositories'] as const;

/** What the settings page needs to render the "Create GitHub App" form. */
export const ManifestFormData = Type.Object(
	{
		/** Absolute URL the browser form POSTs to (github.com or the fake). */
		postUrl: Type.String(),
		/** JSON-encoded GitHubAppManifest for the hidden `manifest` field. */
		manifest: Type.String(),
		/** Nonce echoed back by GitHub; also stored server-side (10 min TTL). */
		state: Type.String(),
		expiresAt: EpochMs
	},
	closed
);
export type ManifestFormData = Static<typeof ManifestFormData>;

export const BeginManifestInput = Type.Object(
	{
		/** Create under an organization instead of the signed-in user. */
		organization: Type.Optional(Login),
		/** App name; default `granary-<ORIGIN host>` truncated to 34 chars. */
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 34 }))
	},
	closed
);
export type BeginManifestInput = Static<typeof BeginManifestInput>;

/** GitHub's `POST /app-manifests/{code}/conversions` response (subset). */
export const ManifestConversion = Type.Object(
	{
		id: Type.Integer(),
		slug: Type.String(),
		node_id: Type.Optional(Type.String()),
		name: Type.String(),
		html_url: Type.String(),
		owner: Type.Object({ login: Type.String(), type: Type.Optional(Type.String()) }, open),
		client_id: Type.String(),
		client_secret: Type.String(),
		webhook_secret: Nullable(Type.String()),
		pem: Type.String(),
		permissions: Type.Optional(Type.Record(Type.String(), Type.String())),
		events: Type.Optional(Type.Array(Type.String()))
	},
	open
);
export type ManifestConversion = Static<typeof ManifestConversion>;

/** `manifest_states` row (E3 migration): pending manifest nonces. */
export const ManifestStateRow = Type.Object(
	{ state: Type.String(), created_by: Type.String(), created_at: EpochMs, expires_at: EpochMs, used_at: Nullable(EpochMs) },
	closed
);
export type ManifestStateRow = Static<typeof ManifestStateRow>;

// ---------------------------------------------------------------------------
// Stored rows (granary.sqlite, E3 migrations)
// ---------------------------------------------------------------------------

/** `github_app` (single row, id = the app id). Secrets live in the platform store. */
export const GitHubAppRow = Type.Object(
	{
		app_id: Type.Integer(),
		slug: Type.String(),
		name: Type.String(),
		html_url: Type.String(),
		owner_login: Type.String(),
		client_id: Type.String(),
		created_by: Type.String(),
		created_at: EpochMs,
		/** JSON of what the app asks for (`GET /app` / manifest conversion), null until known (ADR 0281). */
		permissions: Nullable(Type.String()),
		events: Nullable(Type.String())
	},
	closed
);
export type GitHubAppRow = Static<typeof GitHubAppRow>;

export const InstallationRow = Type.Object(
	{
		installation_id: Type.Integer(),
		account_login: Type.String(),
		account_type: Type.String(),
		repository_selection: Type.Union([Type.Literal('all'), Type.Literal('selected')]),
		suspended: Type.Integer({ minimum: 0, maximum: 1 }),
		synced_at: EpochMs,
		/** JSON: accepted permissions / subscribed events (ADR 0281). */
		permissions: Type.String(),
		events: Type.String()
	},
	closed
);
export type InstallationRow = Static<typeof InstallationRow>;

export const RepoRow = Type.Object(
	{
		repo_id: Type.Integer(),
		full_name: Type.String(),
		installation_id: Nullable(Type.Integer()),
		/** 1 = guarded (default), 0 = webhooks for it are stored as ignored. */
		enabled: Type.Integer({ minimum: 0, maximum: 1 }),
		/** 1 = pull requests gated when the installation has PR access (ADR 0280). */
		prs_enabled: Type.Integer({ minimum: 0, maximum: 1 }),
		updated_by: Nullable(Type.String()),
		updated_at: EpochMs
	},
	closed
);
export type RepoRow = Static<typeof RepoRow>;

// ---------------------------------------------------------------------------
// App auth (ADR 0160)
// ---------------------------------------------------------------------------

/** `POST /app/installations/{id}/access_tokens` response (subset). */
export const InstallationToken = Type.Object(
	{ token: Type.String(), expires_at: Type.String(), permissions: Type.Optional(Type.Record(Type.String(), Type.String())) },
	open
);
export type InstallationToken = Static<typeof InstallationToken>;

/** `GET /app/installations` item (subset). */
export const GitHubInstallation = Type.Object(
	{
		id: Type.Integer(),
		account: Type.Object({ login: Type.String(), type: Type.String() }, open),
		repository_selection: Type.Union([Type.Literal('all'), Type.Literal('selected')]),
		suspended_at: Type.Optional(Nullable(Type.String())),
		/** Permissions the account accepted for this installation (ADR 0281). */
		permissions: Type.Optional(Type.Record(Type.String(), Type.String())),
		events: Type.Optional(Type.Array(Type.String()))
	},
	open
);
export type GitHubInstallation = Static<typeof GitHubInstallation>;

/** `GET /app` (subset): what the app asks for (ADR 0281). */
export const GitHubAppInfo = Type.Object(
	{
		id: Type.Integer(),
		slug: Type.Optional(Type.String()),
		permissions: Type.Optional(Type.Record(Type.String(), Type.String())),
		events: Type.Optional(Type.Array(Type.String()))
	},
	open
);
export type GitHubAppInfo = Static<typeof GitHubAppInfo>;

/** `GET /installation/repositories` response (subset). */
export const InstallationRepositories = Type.Object(
	{
		total_count: Type.Integer(),
		repositories: Type.Array(Type.Object({ id: Type.Integer(), full_name: Type.String(), private: Type.Optional(Type.Boolean()) }, open))
	},
	open
);
export type InstallationRepositories = Static<typeof InstallationRepositories>;

/** `GET /app/hook/deliveries` item (ADR 0162). */
export const AppHookDelivery = Type.Object(
	{
		id: Type.Integer(),
		guid: Type.String(),
		delivered_at: Type.String(),
		redelivery: Type.Boolean(),
		duration: Type.Optional(Type.Number()),
		status: Type.String(),
		status_code: Type.Integer(),
		event: Type.String(),
		action: Nullable(Type.String()),
		installation_id: Type.Optional(Nullable(Type.Integer())),
		repository_id: Type.Optional(Nullable(Type.Integer()))
	},
	open
);
export type AppHookDelivery = Static<typeof AppHookDelivery>;

// ---------------------------------------------------------------------------
// DTOs for the settings UI and CLI
// ---------------------------------------------------------------------------

export const RepoSummary = Type.Object(
	{
		repoId: Type.Integer(),
		fullName: Type.String(),
		installationId: Nullable(Type.Integer()),
		/** Issues are gated (the original switch). */
		enabled: Type.Boolean(),
		/** Pull requests are gated (ADR 0280); effective only with PR access (`prAccess`). */
		prsEnabled: Type.Boolean(),
		/** The repo's installation accepted `pull_requests: write` (ADR 0281). */
		prAccess: Type.Boolean()
	},
	closed
);
export type RepoSummary = Static<typeof RepoSummary>;

export const InstallationSummary = Type.Object(
	{
		installationId: Type.Integer(),
		account: Type.String(),
		accountType: Type.String(),
		repositorySelection: Type.Union([Type.Literal('all'), Type.Literal('selected')]),
		suspended: Type.Boolean(),
		/** Accepted `pull_requests: write` (ADR 0281). */
		prAccess: Type.Boolean(),
		repos: Type.Array(RepoSummary),
		syncedAt: EpochMs
	},
	closed
);
export type InstallationSummary = Static<typeof InstallationSummary>;

export const CatchupStatus = Type.Object(
	{
		lastPassAt: Nullable(EpochMs),
		lastPassRedelivered: Type.Integer(),
		totalRedelivered: Type.Integer(),
		lastError: Nullable(Type.String())
	},
	closed
);
export type CatchupStatus = Static<typeof CatchupStatus>;

export const GitHubStatus = Type.Object(
	{
		mode: GitHubMode,
		app: Nullable(
			Type.Object(
				{
					appId: Type.Integer(),
					slug: Type.String(),
					name: Type.String(),
					htmlUrl: Type.String(),
					owner: Type.String(),
					/** `https://github.com/apps/<slug>/installations/new` (or the fake's). */
					installUrl: Type.String(),
					createdAt: EpochMs
				},
				closed
			)
		),
		/** Last `GET /app` check. */
		auth: Type.Object(
			{ ok: Nullable(Type.Boolean()), checkedAt: Nullable(EpochMs), error: Nullable(Type.String()) },
			closed
		),
		installations: Type.Array(InstallationSummary),
		/**
		 * Pull request access (ADR 0281): the app must ask for
		 * `pull_requests: write` and the `pull_request` event, and each
		 * installation must accept them. Null while unknown (no app / not checked).
		 */
		pullRequests: Nullable(
			Type.Object(
				{
					appPermission: Type.Boolean(),
					appEvent: Type.Boolean(),
					/** Installations that have not accepted the permission yet. */
					pendingInstallations: Type.Array(Type.Object({ installationId: Type.Integer(), account: Type.String() }, closed)),
					/** `https://github.com/settings/apps/<slug>/permissions` (or the org variant / the fake's). */
					permissionsUrl: Type.String(),
					ready: Type.Boolean()
				},
				closed
			)
		),
		webhookUrl: Type.String(),
		catchup: Nullable(CatchupStatus)
	},
	closed
);
export type GitHubStatus = Static<typeof GitHubStatus>;

export const RepoSwitch = Type.Union([Type.Literal('issues'), Type.Literal('pull_requests')]);
export type RepoSwitch = Static<typeof RepoSwitch>;
/** `kind` absent = issues (the original switch). */
export const SetRepoEnabledInput = Type.Object(
	{ repoId: Type.Integer(), enabled: Type.Boolean(), kind: Type.Optional(RepoSwitch) },
	closed
);
export type SetRepoEnabledInput = Static<typeof SetRepoEnabledInput>;

/** Result of the manifest callback, for the page it redirects to. */
export const CompleteManifestResult = Type.Object(
	{ appId: Type.Integer(), slug: Type.String(), installUrl: Type.String() },
	closed
);
export type CompleteManifestResult = Static<typeof CompleteManifestResult>;
