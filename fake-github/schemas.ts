/**
 * Fake GitHub `/__control` API bodies and responses (ADR 0006, ADR 0035).
 * GitHub-compatible shapes (issues, comments, webhook payloads) come from
 * `src/lib/schemas/github.ts`.
 *
 * All control requests and responses are JSON. Errors: 400 for a body that
 * fails its schema, 404 for an unknown repo / issue / delivery; body is
 * `ControlError`.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
	AuthorAssociation,
	Issue,
	IssueComment,
	Login,
	Nullable,
	RepoName,
	UserType
} from '../src/lib/schemas/github';
import { parse } from '../src/lib/schemas/standard';

const closed = { additionalProperties: false } as const;

/** Control API paths. */
export const CONTROL_PATHS = {
	reset: '/__control/reset',
	users: '/__control/users',
	repos: '/__control/repos',
	issues: '/__control/issues',
	reopen: '/__control/issues/reopen',
	redeliver: (deliveryId: string) => `/__control/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
	faults: '/__control/faults',
	state: '/__control/state',
	/** ADR 0075 */
	comment: '/__control/issues/comment',
	rawDelivery: '/__control/deliveries/raw',
	events: '/__control/events',
	eventsLog: '/__control/events/log',
	/** ADR 0164: install a GitHub App without the UI. */
	appInstallations: (appId: number) => `/__control/apps/${appId}/installations`,
	/** Install the app on every account (all repos) the first time one of its repos has an event (ADR 0230). */
	appAutoInstall: (appId: number) => `/__control/apps/${appId}/auto-install`,
	/** ADR 0164: while down, webhook deliveries fail with status_code 0 (catch-up tests). */
	webhookOutage: '/__control/webhook-outage',
	/** ADR 0282: open a pull request as a user; delivers `pull_request`/`opened`. */
	pulls: '/__control/pulls',
	/** ADR 0282: change what an app asks for (installations keep the old set until they accept). */
	appPermissions: (appId: number) => `/__control/apps/${appId}/permissions`,
	/** ADR 0282: the account accepts the app's current permissions; delivers `installation`/`new_permissions_accepted`. */
	acceptPermissions: (installationId: number) => `/__control/installations/${installationId}/accept-permissions`
} as const;

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export const ControlOk = Type.Object({ ok: Type.Literal(true) }, closed);
export type ControlOk = Static<typeof ControlOk>;

export const ControlError = Type.Object(
	{
		error: Type.String(),
		issues: Type.Optional(
			Type.Array(Type.Object({ message: Type.String(), path: Type.Array(Type.Union([Type.String(), Type.Number()])) }))
		)
	},
	closed
);
export type ControlError = Static<typeof ControlError>;

// ---------------------------------------------------------------------------
// POST /__control/reset  (optional body {keepApps}) → ControlOk
// ---------------------------------------------------------------------------

/** `keepApps`: registered GitHub Apps (and their auto-install flag) survive the reset (ADR 0230). */
export const ResetRequest = Type.Object({ keepApps: Type.Optional(Type.Boolean()) }, closed);
export type ResetRequest = Static<typeof ResetRequest>;

export const ResetResponse = ControlOk;
export type ResetResponse = ControlOk;

// ---------------------------------------------------------------------------
// POST /__control/users {login, type?} → FakeUser   (idempotent "ensure")
// ---------------------------------------------------------------------------

export const EnsureUserRequest = Type.Object(
	{ login: Login, type: Type.Optional(UserType) },
	closed
);
export type EnsureUserRequest = Static<typeof EnsureUserRequest>;

export const FakeUser = Type.Object(
	{ login: Type.String(), id: Type.Integer(), type: UserType, avatarUrl: Type.String() },
	closed
);
export type FakeUser = Static<typeof FakeUser>;

export const EnsureUserResponse = FakeUser;
export type EnsureUserResponse = FakeUser;

// ---------------------------------------------------------------------------
// POST /__control/repos {owner, name} → {id}   (idempotent "ensure"; also ensures the owner user)
// ---------------------------------------------------------------------------

export const EnsureRepoRequest = Type.Object({ owner: Login, name: RepoName }, closed);
export type EnsureRepoRequest = Static<typeof EnsureRepoRequest>;

export const EnsureRepoResponse = Type.Object({ id: Type.Integer() }, closed);
export type EnsureRepoResponse = Static<typeof EnsureRepoResponse>;

export const FakeRepo = Type.Object(
	{ id: Type.Integer(), owner: Type.String(), name: Type.String(), fullName: Type.String() },
	closed
);
export type FakeRepo = Static<typeof FakeRepo>;

// ---------------------------------------------------------------------------
// POST /__control/issues → {number, deliveryId}
// Ensures the repo and the author exist, creates the issue (state open),
// then delivers `issues`/`opened` to every installed GitHub App covering the repo.
// `association` defaults to 'NONE'; `body` defaults to ''.
// The response is sent after the delivery attempt finished.
// ---------------------------------------------------------------------------

export const CreateIssueRequest = Type.Object(
	{
		owner: Login,
		repo: RepoName,
		author: Login,
		title: Type.String({ minLength: 1 }),
		body: Type.Optional(Type.String()),
		association: Type.Optional(AuthorAssociation)
	},
	closed
);
export type CreateIssueRequest = Static<typeof CreateIssueRequest>;

export const CreateIssueResponse = Type.Object(
	/** Null when no installed GitHub App covers the repo (nothing is delivered). */
	{ number: Type.Integer({ minimum: 1 }), deliveryId: Nullable(Type.String()) },
	closed
);
export type CreateIssueResponse = Static<typeof CreateIssueResponse>;

// ---------------------------------------------------------------------------
// POST /__control/issues/reopen {owner, repo, number, actor} → {deliveryId}
// Sets state open / state_reason reopened, delivers `issues`/`reopened` with sender = actor.
// ---------------------------------------------------------------------------

export const ReopenIssueRequest = Type.Object(
	{ owner: Login, repo: RepoName, number: Type.Integer({ minimum: 1 }), actor: Login },
	closed
);
export type ReopenIssueRequest = Static<typeof ReopenIssueRequest>;

export const ReopenIssueResponse = Type.Object({ deliveryId: Nullable(Type.String()) }, closed);
export type ReopenIssueResponse = Static<typeof ReopenIssueResponse>;

// ---------------------------------------------------------------------------
// POST /__control/deliveries/{deliveryId}/redeliver (no body) → RedeliverResponse
// Resends the stored body with the SAME X-GitHub-Delivery id.
// ---------------------------------------------------------------------------

export const RedeliverResponse = Type.Object(
	{ deliveryId: Type.String(), responseCode: Nullable(Type.Integer()) },
	closed
);
export type RedeliverResponse = Static<typeof RedeliverResponse>;

// ---------------------------------------------------------------------------
// POST /__control/faults → {id}
// The next `count` REST calls (GitHub-compatible surface only, not /__control,
// not OAuth) whose method matches (`*` = any) and whose URL pathname matches
// `new RegExp(pathPattern)` (unanchored) fail with `status` and body
// `{"message":"injected fault"}`. `retryAfter` (seconds) adds a `Retry-After` header.
// ---------------------------------------------------------------------------

export const FaultMethod = Type.Union([
	Type.Literal('GET'),
	Type.Literal('POST'),
	Type.Literal('PATCH'),
	Type.Literal('PUT'),
	Type.Literal('DELETE'),
	Type.Literal('*')
]);
export type FaultMethod = Static<typeof FaultMethod>;

export const InjectFaultRequest = Type.Object(
	{
		method: FaultMethod,
		pathPattern: Type.String({ minLength: 1 }),
		status: Type.Integer({ minimum: 400, maximum: 599 }),
		count: Type.Integer({ minimum: 1 }),
		retryAfter: Type.Optional(Type.Integer({ minimum: 0 }))
	},
	closed
);
export type InjectFaultRequest = Static<typeof InjectFaultRequest>;

export const InjectFaultResponse = Type.Object({ id: Type.String() }, closed);
export type InjectFaultResponse = Static<typeof InjectFaultResponse>;

export const FakeFault = Type.Object(
	{
		id: Type.String(),
		method: FaultMethod,
		pathPattern: Type.String(),
		status: Type.Integer(),
		/** Remaining matching calls that will fail. */
		remaining: Type.Integer({ minimum: 0 }),
		retryAfter: Type.Optional(Type.Integer())
	},
	closed
);
export type FakeFault = Static<typeof FakeFault>;

// ---------------------------------------------------------------------------
// GET /__control/state → FakeState
// ---------------------------------------------------------------------------

/** An issue as GitHub would return it, plus where it lives and its comments. */
export const FakeIssue = Type.Intersect([
	Issue,
	Type.Object({
		repoId: Type.Integer(),
		owner: Type.String(),
		repo: Type.String(),
		comments: Type.Array(IssueComment),
		/** Present for pull requests (ADR 0282). */
		pullRequest: Type.Optional(Type.Object({ draft: Type.Boolean() }))
	})
]);
export type FakeIssue = Static<typeof FakeIssue>;

export const FakeDeliveryStatus = Type.Union([
	Type.Literal('pending'),
	Type.Literal('delivered'),
	Type.Literal('failed')
]);
export type FakeDeliveryStatus = Static<typeof FakeDeliveryStatus>;

export const FakeDelivery = Type.Object(
	{
		id: Type.String(),
		event: Type.String(),
		action: Type.String(),
		/** `delivered`: last attempt got 2xx; `failed`: non-2xx or unreachable. */
		status: FakeDeliveryStatus,
		/** HTTP status of the last attempt; null if unreachable / not yet sent. */
		responseCode: Nullable(Type.Integer()),
		repoId: Type.Optional(Type.Integer()),
		issueNumber: Type.Optional(Type.Integer()),
		/** Number of times sent (1 + redeliveries). */
		attempts: Type.Optional(Type.Integer()),
		/** Epoch ms of the last attempt. */
		lastAttemptAt: Type.Optional(Nullable(Type.Integer()))
	},
	closed
);
export type FakeDelivery = Static<typeof FakeDelivery>;

// ---------------------------------------------------------------------------
// ADR 0164: GitHub Apps (manifest flow, installations, app hook deliveries)
// ---------------------------------------------------------------------------

export const FakeApp = Type.Object(
	{
		id: Type.Integer(),
		slug: Type.String(),
		name: Type.String(),
		owner: Login,
		clientId: Type.String(),
		/** Manifest URLs, as registered. */
		webhookUrl: Type.String(),
		redirectUrl: Type.String(),
		setupUrl: Type.Union([Type.String(), Type.Null()]),
		callbackUrls: Type.Array(Type.String()),
		permissions: Type.Record(Type.String(), Type.String()),
		events: Type.Array(Type.String()),
		createdAt: Type.Number(),
		/** Installed automatically on every account with repo activity (ADR 0230). */
		autoInstall: Type.Optional(Type.Boolean())
	},
	closed
);
export type FakeApp = Static<typeof FakeApp>;

export const FakeInstallation = Type.Object(
	{
		id: Type.Integer(),
		appId: Type.Integer(),
		account: Login,
		accountType: Type.Union([Type.Literal('User'), Type.Literal('Organization')]),
		repositorySelection: Type.Union([Type.Literal('all'), Type.Literal('selected')]),
		/** Repo full names (`owner/name`) when `selected`. */
		repos: Type.Array(Type.String()),
		suspended: Type.Boolean(),
		createdAt: Type.Number(),
		/** Accepted permissions / events (ADR 0282). */
		permissions: Type.Optional(Type.Record(Type.String(), Type.String())),
		events: Type.Optional(Type.Array(Type.String()))
	},
	closed
);
export type FakeInstallation = Static<typeof FakeInstallation>;

/** One entry of an app's delivery log (`GET /app/hook/deliveries`). */
export const FakeAppDelivery = Type.Object(
	{
		id: Type.Integer(),
		appId: Type.Integer(),
		guid: Type.String(),
		event: Type.String(),
		action: Type.Union([Type.String(), Type.Null()]),
		deliveredAt: Type.Number(),
		redelivery: Type.Boolean(),
		/** 0 when the delivery could not connect (outage). */
		statusCode: Type.Integer(),
		installationId: Type.Union([Type.Integer(), Type.Null()]),
		repositoryId: Type.Union([Type.Integer(), Type.Null()])
	},
	closed
);
export type FakeAppDelivery = Static<typeof FakeAppDelivery>;

/** POST /__control/apps/{appId}/installations */
export const InstallAppRequest = Type.Object(
	{
		account: Login,
		accountType: Type.Optional(Type.Union([Type.Literal('User'), Type.Literal('Organization')])),
		/** Omit for `all`; repos are created if missing. */
		repos: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' })))
	},
	closed
);
export type InstallAppRequest = Static<typeof InstallAppRequest>;
export const InstallAppResponse = Type.Object({ installationId: Type.Integer(), deliveryId: Type.String() }, closed);
export type InstallAppResponse = Static<typeof InstallAppResponse>;

// ---------------------------------------------------------------------------
// Pull requests and app permissions (ADR 0282)
// ---------------------------------------------------------------------------

/** POST /__control/pulls → {number, deliveryId} (PRs share the repo's issue number sequence). */
export const CreatePullRequestRequest = Type.Object(
	{
		owner: Login,
		repo: RepoName,
		author: Login,
		title: Type.String({ minLength: 1 }),
		body: Type.Optional(Type.String()),
		association: Type.Optional(AuthorAssociation),
		draft: Type.Optional(Type.Boolean())
	},
	closed
);
export type CreatePullRequestRequest = Static<typeof CreatePullRequestRequest>;
export const CreatePullRequestResponse = CreateIssueResponse;
export type CreatePullRequestResponse = Static<typeof CreatePullRequestResponse>;

/** POST /__control/apps/{appId}/permissions → the app (as in state). */
export const SetAppPermissionsRequest = Type.Object(
	{ permissions: Type.Record(Type.String(), Type.Union([Type.Literal('read'), Type.Literal('write')])), events: Type.Array(Type.String()) },
	closed
);
export type SetAppPermissionsRequest = Static<typeof SetAppPermissionsRequest>;

/** POST /__control/installations/{id}/accept-permissions → {installationId, deliveryId}. */
export const AcceptPermissionsResponse = Type.Object(
	{ installationId: Type.Integer(), deliveryId: Nullable(Type.String()) },
	closed
);
export type AcceptPermissionsResponse = Static<typeof AcceptPermissionsResponse>;

/** POST /__control/apps/{appId}/auto-install */
export const AppAutoInstallRequest = Type.Object({ enabled: Type.Boolean() }, closed);
export type AppAutoInstallRequest = Static<typeof AppAutoInstallRequest>;

/** POST /__control/webhook-outage */
export const WebhookOutageRequest = Type.Object({ down: Type.Boolean() }, closed);
export type WebhookOutageRequest = Static<typeof WebhookOutageRequest>;

export const FakeState = Type.Object(
	{
		users: Type.Array(FakeUser),
		repos: Type.Array(FakeRepo),
		issues: Type.Array(FakeIssue),
		/** Oldest first. */
		deliveries: Type.Array(FakeDelivery),
		faults: Type.Array(FakeFault),
		/** ADR 0164 (optional until the fake implements GitHub Apps). */
		apps: Type.Optional(Type.Array(FakeApp)),
		installations: Type.Optional(Type.Array(FakeInstallation)),
		appDeliveries: Type.Optional(Type.Array(FakeAppDelivery)),
		webhookOutage: Type.Optional(Type.Boolean())
	},
	closed
);
export type FakeState = Static<typeof FakeState>;
export const StateResponse = FakeState;
export type StateResponse = FakeState;

// ---------------------------------------------------------------------------
// ADR 0075: user comments, raw deliveries, event stream
// ---------------------------------------------------------------------------

/** POST /__control/issues/comment — comment as `author`, delivers `issue_comment`/`created`. */
export const CreateCommentControlRequest = Type.Object(
	{
		owner: Login,
		repo: RepoName,
		number: Type.Integer({ minimum: 1 }),
		author: Login,
		body: Type.String({ minLength: 1, maxLength: 65536 })
	},
	closed
);
export type CreateCommentControlRequest = Static<typeof CreateCommentControlRequest>;

export const CreateCommentControlResponse = Type.Object(
	{ commentId: Type.Integer(), deliveryId: Nullable(Type.String()) },
	closed
);
export type CreateCommentControlResponse = Static<typeof CreateCommentControlResponse>;

/** POST /__control/deliveries/raw — sign and deliver an arbitrary body (fuzzing). */
export const RawDeliveryRequest = Type.Object(
	{
		event: Type.String({ minLength: 1, maxLength: 100 }),
		body: Type.String({ maxLength: 4 * 1024 * 1024 }),
		action: Type.Optional(Type.String({ maxLength: 100 })),
		deliveryId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 }))
	},
	closed
);
export type RawDeliveryRequest = Static<typeof RawDeliveryRequest>;

export const RawDeliveryResponse = Type.Object(
	{ deliveryId: Type.String(), responseCode: Nullable(Type.Integer()) },
	closed
);
export type RawDeliveryResponse = Static<typeof RawDeliveryResponse>;

const EventBase = {
	seq: Type.Integer({ minimum: 1 }),
	/** Epoch ms. */
	at: Type.Integer()
};
const IssueRef = {
	repoId: Type.Integer(),
	owner: Type.String(),
	repo: Type.String(),
	number: Type.Integer()
};

/** One entry of the fake's event log (`GET /__control/events[/log]`). */
export const FakeEvent = Type.Union([
	Type.Object(
		{
			...EventBase,
			type: Type.Literal('pull_request.opened'),
			...IssueRef,
			author: Type.String(),
			association: AuthorAssociation,
			title: Type.String(),
			draft: Type.Boolean()
		},
		closed
	),
	Type.Object({ ...EventBase, type: Type.Literal('pull_request.closed'), ...IssueRef, by: Type.String() }, closed),
	Type.Object(
		{
			...EventBase,
			type: Type.Literal('issue.opened'),
			...IssueRef,
			author: Type.String(),
			association: AuthorAssociation,
			title: Type.String()
		},
		closed
	),
	Type.Object(
		{
			...EventBase,
			type: Type.Literal('issue.closed'),
			...IssueRef,
			by: Type.String(),
			stateReason: Nullable(Type.String())
		},
		closed
	),
	Type.Object({ ...EventBase, type: Type.Literal('issue.reopened'), ...IssueRef, by: Type.String() }, closed),
	Type.Object(
		{
			...EventBase,
			type: Type.Literal('comment.created'),
			...IssueRef,
			commentId: Type.Integer(),
			author: Type.String(),
			body: Type.String()
		},
		closed
	),
	Type.Object(
		{
			...EventBase,
			type: Type.Literal('delivery'),
			deliveryId: Type.String(),
			event: Type.String(),
			action: Type.String(),
			repoId: Nullable(Type.Integer()),
			number: Nullable(Type.Integer()),
			responseCode: Nullable(Type.Integer()),
			attempt: Type.Integer()
		},
		closed
	)
]);
export type FakeEvent = Static<typeof FakeEvent>;
/** A FakeEvent before the log assigns `seq` / `at`. */
export type FakeEventInput = FakeEvent extends infer E ? (E extends FakeEvent ? Omit<E, 'seq' | 'at'> : never) : never;

export const EventsLogResponse = Type.Object(
	{ events: Type.Array(FakeEvent), lastSeq: Type.Integer({ minimum: 0 }) },
	closed
);
export type EventsLogResponse = Static<typeof EventsLogResponse>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const parseFakeState = (v: unknown): FakeState => parse(FakeState, v, 'fake GitHub state');
