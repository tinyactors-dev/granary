/**
 * The seam between the UI (remote functions) and the actor system (ADR 0032).
 *
 * Remote functions validate input, authorize, and call `getBackend()`.
 * The actor-system implementation (WAL, relay, tinyactors system, fake-GitHub
 * client) implements `Backend` and registers it with `setBackend()` from
 * `hooks.server.ts` `init`. `StubBackend` (backend.stub.ts) is a fake for UI
 * work, registered only when `GRANARY_STUB_BACKEND=1`.
 *
 * Conventions:
 * - All timestamps are epoch milliseconds.
 * - Inputs are already validated (TypeBox) and `limit` defaults resolved.
 * - Expected failures throw `BackendError` with a `code`; remote functions map
 *   codes to HTTP statuses (see `backendErrorStatus`). Anything else is a 500.
 * - Dev methods (`dev*`, `getDevInfo`, `getRecentSpans`, `getDapLaunchConfig`)
 *   may throw `BackendError('unavailable')` when not in dev mode; callers
 *   already guard with `requireDev()`.
 */
import type {
	ActorSnapshot,
	ActorSummary,
	AddAllowedUserResult,
	AllowedUser,
	CreateSessionInput,
	CreatedSession,
	DeliverySummary,
	EffectSummary,
	IssueDetail,
	ListDeliveriesInput,
	ListEffectsInput,
	ListVerdictsInput,
	Overview,
	Page,
	RemoveAllowedUserResult,
	Resolved,
	SessionUser,
	VerdictSummary
} from '$lib/schemas/api';
import type { ActorAddress } from '$lib/schemas/actors';
import type {
	AddAdminResult,
	Admin,
	AuditEntry,
	CreatedLoginLink,
	CreateLoginLinkInput,
	LoginLinkSummary,
	RevokeLoginLinkResult,
	RemoveAdminResult,
	SetupStatus
} from '$lib/schemas/admins';
import type {
	BeginManifestInput,
	CompleteManifestResult,
	GitHubStatus,
	InstallationSummary,
	ManifestFormData,
	RepoSummary,
	SetRepoEnabledInput
} from '$lib/schemas/github-app';
import type {
	DapLaunchConfig,
	DevInfo,
	DevTool,
	DevInjectFaultInput,
	DevInjectFaultResult,
	DevOpenIssueInput,
	DevOpenIssueResult,
	DevRedeliverResult,
	DevReopenIssueInput,
	DevReopenIssueResult,
	DevSendEvent,
	DevSendEventResult,
	GetRecentSpansInput,
	ListRecentTracesInput,
	SpanSummary,
	TraceSummary,
	CreateScenarioRequest,
	LoadgenInfo,
	FakeInfraAction,
	FakeInfraActionResult,
	FakeInfraInfo,
	ListPersonasQuery,
	PersonaDetail,
	PersonaKind,
	PersonaKindInfo,
	PersonaSummary,
	ScenarioAction,
	ScenarioDetail,
	ScenarioSummary
} from '$lib/schemas/dev';

export interface Backend {
	// -- sessions (ADR 0034) ---------------------------------------------------

	/**
	 * Look up a session cookie value. Returns null for unknown or expired
	 * sessions. `isAdmin` is computed from the admins table at call time.
	 * Used by `hooks.server.ts` to fill `locals.user`.
	 */
	resolveSession(sessionId: string): Promise<SessionUser | null>;

	/**
	 * Insert a `sessions` row (random id, expires in 30 days). Used by
	 * `/auth/callback` and `devLoginAs`. The caller sets the cookie.
	 */
	createSession(input: CreateSessionInput): Promise<CreatedSession>;

	/** Delete a session row. Unknown ids are ignored. */
	deleteSession(sessionId: string): Promise<void>;

	// -- dashboard -------------------------------------------------------------

	getOverview(): Promise<Overview>;
	listDeliveries(query: Resolved<ListDeliveriesInput>): Promise<Page<DeliverySummary>>;
	listEffects(query: Resolved<ListEffectsInput>): Promise<Page<EffectSummary>>;
	listVerdicts(query: Resolved<ListVerdictsInput>): Promise<Page<VerdictSummary>>;
	/** null when the key appears in no table and no actor is resident. */
	getIssue(issueKey: string): Promise<IssueDetail | null>;

	// -- allowlist (ADR 0004) --------------------------------------------------

	/** Sorted by login (case-insensitive). */
	listAllowedUsers(): Promise<AllowedUser[]>;
	/**
	 * Insert into allowed_users (idempotent, case-insensitive), then post
	 * `allowlist.replace` with the full set to `allowlist/main`.
	 */
	addAllowedUser(login: string, addedBy: string): Promise<AddAllowedUserResult>;
	/** Delete from allowed_users, then post `allowlist.replace`. */
	removeAllowedUser(login: string, removedBy: string): Promise<RemoveAllowedUserResult>;

	// -- effects -----------------------------------------------------------------

	/**
	 * Reset a `dead` (or `pending` with a future next_attempt_at) outbox row to
	 * `pending`, attempts 0, next_attempt_at now; kick the relay.
	 * Throws `BackendError('not-found')` for an unknown key and
	 * `BackendError('conflict')` when the row is `done` or `inflight`.
	 */
	retryEffect(effectKey: string, requestedBy: string): Promise<EffectSummary>;

	// -- actors ------------------------------------------------------------------

	/** Resident actors, ordered by family then name. */
	listActors(): Promise<ActorSummary[]>;
	/**
	 * Full snapshot of the resident actor at `address` (ADR 0056), or null when
	 * no actor is resident there (never loaded, finished, or unloaded).
	 * Inspecting never loads an actor.
	 */
	inspectActor(address: ActorAddress): Promise<ActorSnapshot | null>;

	// -- dev (ADR 0009) ------------------------------------------------------------

	getDevInfo(): Promise<DevInfo>;
	/** Every UI worth opening, from config + ops config, with reachability (ADR 0154). */
	getDevTools(): Promise<DevTool[]>;
	/** Ensures the repo (`POST /__control/repos`) then `POST /__control/issues`. */
	devOpenIssue(input: DevOpenIssueInput): Promise<DevOpenIssueResult>;
	devReopenIssue(input: DevReopenIssueInput): Promise<DevReopenIssueResult>;
	devRedeliver(deliveryId: string): Promise<DevRedeliverResult>;
	devInjectFault(input: DevInjectFaultInput): Promise<DevInjectFaultResult>;
	/** `POST /__control/reset` on the fake GitHub. Does not touch the app's DB. */
	devReset(): Promise<void>;
	/**
	 * `system.send(address, event, data, {until: 'completed', timeout: 5000})`.
	 * Throws `BackendError('not-found')` when the send dead-letters as not-found,
	 * `BackendError('invalid')` for other send rejections (message = code).
	 */
	devSendEvent(input: DevSendEvent): Promise<DevSendEventResult>;
	/** From the in-memory ring buffer (last SPAN_BUFFER_SIZE spans), newest first. */
	getRecentSpans(query: Resolved<GetRecentSpansInput>): Promise<SpanSummary[]>;
	/** The ring buffer grouped by trace, newest first (ADR 0054). */
	listRecentTraces(query: Resolved<ListRecentTracesInput>): Promise<TraceSummary[]>;
	getDapLaunchConfig(address: ActorAddress): Promise<DapLaunchConfig>;

	// -- load generator (ADR 0070–0076), dev only; proxies LOADGEN_URL ----------------

	/** Never throws for an unreachable loadgen: `reachable: false` instead. */
	getLoadgenStatus(): Promise<LoadgenInfo>;
	/** Newest first. */
	listScenarios(): Promise<ScenarioSummary[]>;
	/** `not-found` for an unknown id. */
	getScenario(id: string): Promise<ScenarioDetail>;
	/** `invalid` for a bad config, `conflict` when another scenario runs. */
	createScenario(request: CreateScenarioRequest): Promise<ScenarioSummary>;
	/** `conflict` when the action does not apply to the scenario's state. */
	controlScenario(id: string, action: ScenarioAction): Promise<ScenarioSummary>;
	listPersonas(query: ListPersonasQuery): Promise<PersonaSummary[]>;
	getPersona(kind: PersonaKind, name: string): Promise<PersonaDetail>;
	/** The persona catalogue with each kind's statechart. */
	listPersonaKinds(): Promise<PersonaKindInfo[]>;
	/** Stop everything and forget all scenarios. */
	resetLoadgen(): Promise<void>;

	// -- setup, admins, login links (ADR 0161) -----------------------

	getSetupStatus(): Promise<SetupStatus>;
	/** Sorted by login (case-insensitive). */
	listAdmins(): Promise<Admin[]>;
	/** Idempotent. `invalid` for a malformed login. */
	addAdmin(login: string, addedBy: string, source: Admin['source']): Promise<AddAdminResult>;
	/** `conflict` when it would remove the last admin. */
	removeAdmin(login: string, removedBy: string): Promise<RemoveAdminResult>;
	/** `invalid` when the login is not an admin. The URL is shown once. */
	createLoginLink(input: CreateLoginLinkInput, createdBy: string): Promise<CreatedLoginLink>;
	/**
	 * Atomically consume a login-link token (single use, unexpired, login still
	 * an admin) and create a session. null when invalid/expired/used.
	 */
	consumeLoginLink(token: string): Promise<CreatedSession | null>;
	/** Newest first, without tokens (ADR 0170). */
	listLoginLinks(limit: number): Promise<LoginLinkSummary[]>;
	/** `not-found` for an unknown id; `revoked: false` when already used/expired/revoked. */
	revokeLoginLink(id: string, revokedBy: string): Promise<RevokeLoginLinkResult>;
	/** Newest first. */
	listAuditLog(limit: number): Promise<AuditEntry[]>;

	// -- GitHub connection (ADR 0160, 0162) -----------------------

	getGitHubStatus(): Promise<GitHubStatus>;
	/** Stores a manifest nonce (10 min) and returns what the settings form POSTs to GitHub. */
	beginGitHubAppManifest(input: BeginManifestInput, requestedBy: string): Promise<ManifestFormData>;
	/**
	 * Exchange the manifest `code` (after checking `state`), store the app and
	 * its secrets, switch mode to `app`. `invalid` for a bad/expired state,
	 * `upstream` when GitHub rejects the code, `conflict` when an app exists.
	 */
	completeGitHubAppManifest(code: string, state: string, actor: string): Promise<CompleteManifestResult>;
	/** Re-sync installations and their repositories from GitHub. */
	refreshGitHubInstallations(actor: string): Promise<InstallationSummary[]>;
	/**
	 * Stop acting on GitHub (ADR 0220): mode → `none`, the app row,
	 * installations and all stored GitHub credentials are deleted; per-repo
	 * enable choices are kept. The app itself must be deleted on GitHub.
	 */
	disconnectGitHub(actor: string): Promise<GitHubStatus>;
	/** `not-found` for an unknown repo. */
	setRepoEnabled(input: SetRepoEnabledInput, actor: string): Promise<RepoSummary>;

	// -- fake-infra (ADR 0130–0139), dev only; proxies FAKE_INFRA_URL -------------------

	/** Never throws for an unreachable fake-infra: `reachable: false` instead. */
	getFakeInfraStatus(): Promise<FakeInfraInfo>;
	/** One control action (buckets, credentials, faults, fidelity, clock, exe proxy, reset). */
	fakeInfraControl(action: FakeInfraAction): Promise<FakeInfraActionResult>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BackendErrorCode = 'not-found' | 'conflict' | 'invalid' | 'unavailable' | 'upstream';

/** Expected failure of a Backend call. */
export class BackendError extends Error {
	readonly code: BackendErrorCode;
	constructor(code: BackendErrorCode, message: string) {
		super(message);
		this.name = 'BackendError';
		this.code = code;
	}
}

export const isBackendError = (e: unknown): e is BackendError =>
	e instanceof BackendError ||
	(e instanceof Error && e.name === 'BackendError' && typeof (e as BackendError).code === 'string');

/** HTTP status for a BackendError code. `upstream` = fake/real GitHub failed. */
export function backendErrorStatus(code: BackendErrorCode): 400 | 404 | 409 | 502 | 503 {
	switch (code) {
		case 'not-found':
			return 404;
		case 'conflict':
			return 409;
		case 'invalid':
			return 400;
		case 'upstream':
			return 502;
		case 'unavailable':
			return 503;
	}
}

// ---------------------------------------------------------------------------
// Registry (globalThis, survives Vite HMR)
// ---------------------------------------------------------------------------

const KEY = Symbol.for('granary.backend');
type Registry = { [KEY]?: Backend };

/** Register the backend instance (call once from `hooks.server.ts` `init`). */
export function setBackend(backend: Backend | null): void {
	const g = globalThis as Registry;
	if (backend) g[KEY] = backend;
	else delete g[KEY];
}

/** The registered backend. Throws if none has been registered. */
export function getBackend(): Backend {
	const backend = (globalThis as Registry)[KEY];
	if (!backend) {
		throw new Error(
			'granary: no Backend registered. hooks.server.ts `init` must call setBackend(...) ' +
				'(set GRANARY_STUB_BACKEND=1 to use the StubBackend from $lib/server/backend.stub).'
		);
	}
	return backend;
}

/** Whether a backend is registered (for hooks that must not throw). */
export const hasBackend = (): boolean => (globalThis as Registry)[KEY] !== undefined;
