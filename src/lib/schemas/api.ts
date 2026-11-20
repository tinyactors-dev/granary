/**
 * DTOs of the (non-dev) remote functions and of the `Backend` interface.
 * Inputs are validated with `standard(...)`; outputs are produced by the
 * backend and typed only (not validated at runtime). ADR 0031, ADR 0032.
 *
 * All timestamps are epoch milliseconds (numbers). All values are plain
 * JSON-safe data (serialised with devalue by SvelteKit).
 */
import { Type, type Static } from '@sinclair/typebox';
import { ActorAddress, EffectKey, IssueKey } from './actors';
import { AuthorAssociation, Login, Nullable } from './github';
import { EpochMs, InboxState, OutboxPayload, OutboxState, VerdictValue } from './wal';

const closed = { additionalProperties: false } as const;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** The signed-in user (also `App.Locals.user`). `isAdmin` is computed per request from the admins table. */
export const SessionUser = Type.Object(
	{ login: Type.String(), avatarUrl: Nullable(Type.String()), isAdmin: Type.Boolean() },
	closed
);
export type SessionUser = Static<typeof SessionUser>;

/** What `Backend.createSession` returns; the caller sets the `granary_session` cookie. */
export const CreatedSession = Type.Object(
	{ sessionId: Type.String(), expiresAt: EpochMs, user: SessionUser },
	closed
);
export type CreatedSession = Static<typeof CreatedSession>;

export const CreateSessionInput = Type.Object(
	{ login: Type.String({ minLength: 1 }), avatarUrl: Type.Optional(Nullable(Type.String())) },
	closed
);
export type CreateSessionInput = Static<typeof CreateSessionInput>;

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const Limit = Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE });
/**
 * Opaque cursor returned as `Page.nextCursor`; pass back as `before` to get
 * the next (older) page. Backends define the encoding.
 */
export const Cursor = Type.String({ minLength: 1, maxLength: 512 });

export interface Page<T> {
	items: T[];
	/** Cursor for the next (older) page, or null when this is the last page. */
	nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export type Counts<K extends string> = Record<K, number>;

export interface SystemOverview {
	/** Actors in memory (`hostStats().host.actors` less the hibernated). */
	residentActors: number;
	/** Live actors per chart, e.g. `{issue: 3, allowlist: 1}` (`hostStats().charts`). */
	actorsByFamily: Record<string, number>;
	/** Actors with an event to run now (`hostStats().host.runnable`). */
	runnableActors: number;
	/** Events delivered since the host started (`hostStats().host.delivered`). */
	deliveredMessages: number;
	/** Actors that faulted and ended, and execution/communication errors raised in charts (`hostStats().charts`). */
	faults: number;
	errors: number;
	/** The host's memory region (`hostStats().host.regionBytes`). */
	memoryBytes: number;
	/** Epoch ms when the runtime started. */
	startedAt: number;
}

export interface Overview {
	inbox: Counts<InboxState>;
	outbox: Counts<OutboxState>;
	verdicts: Counts<VerdictValue>;
	allowlistSize: number;
	system: SystemOverview;
	/** Earliest `next_attempt_at` of pending outbox rows, or null. */
	nextRelayAttemptAt: number | null;
	generatedAt: number;
}

/** Issue / pull request facts extracted from a stored `issues` or `pull_request` webhook payload. */
export interface IssueSummary {
	/** Absent = issue (ADR 0280). */
	kind?: 'issue' | 'pull_request';
	repoId: number;
	owner: string;
	repo: string;
	number: number;
	title: string;
	author: string;
	association: AuthorAssociation;
	htmlUrl: string;
}

export const ListDeliveriesInput = Type.Object(
	{
		state: Type.Optional(InboxState),
		/** `item`: about an issue or pull request; `other`: installation events, pings, ignored events… */
		about: Type.Optional(Type.Union([Type.Literal('item'), Type.Literal('other')])),
		limit: Type.Optional(Limit),
		before: Type.Optional(Cursor)
	},
	closed
);
export type ListDeliveriesInput = Static<typeof ListDeliveriesInput>;

/** One `inbox` row, newest first by `received_at`. */
export interface DeliverySummary {
	deliveryId: string;
	event: string;
	action: string | null;
	issueKey: string | null;
	state: InboxState;
	receivedAt: number;
	/** Why an `ignored` delivery is not acted on (ADR 0220); null otherwise. */
	ignoreReason: string | null;
	/** From the payload when `event='issues'` and it parses; else null. */
	issue: IssueSummary | null;
}

export const ListEffectsInput = Type.Object(
	{ state: Type.Optional(OutboxState), limit: Type.Optional(Limit), before: Type.Optional(Cursor) },
	closed
);
export type ListEffectsInput = Static<typeof ListEffectsInput>;

/** One `outbox` row, newest first by `updated_at`. */
export interface EffectSummary {
	effectKey: string;
	issueKey: string;
	state: OutboxState;
	attempts: number;
	nextAttemptAt: number | null;
	lastError: string | null;
	commentId: number | null;
	updatedAt: number;
	replyTo: ActorAddress;
	payload: OutboxPayload;
}

export const ListVerdictsInput = Type.Object(
	{ verdict: Type.Optional(VerdictValue), limit: Type.Optional(Limit), before: Type.Optional(Cursor) },
	closed
);
export type ListVerdictsInput = Static<typeof ListVerdictsInput>;

/** One `verdicts` row, newest first by `decided_at`. */
export interface VerdictSummary {
	issueKey: string;
	verdict: VerdictValue;
	reason: string;
	decidedAt: number;
	/** From the latest `issues` inbox row for this key, if any. */
	issue: IssueSummary | null;
}

/**
 * Activity (ADR 0291): one row per item (issue or pull request). `outcome` is
 * the decision (`allowed` | `closed` | `failed`) once made; before that
 * `closing` while the GitHub action is under way, `ignored` when every
 * delivery was ignored, else `pending`.
 */
export const ACTIVITY_OUTCOMES = ['allowed', 'closed', 'failed', 'closing', 'pending', 'ignored'] as const;
export const ActivityOutcome = Type.Union(ACTIVITY_OUTCOMES.map((o) => Type.Literal(o)));
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];
export const ItemKind = Type.Union([Type.Literal('issue'), Type.Literal('pull_request')]);
export type ItemKind = Static<typeof ItemKind>;

export const ListActivityInput = Type.Object(
	{ outcome: Type.Optional(ActivityOutcome), kind: Type.Optional(ItemKind), limit: Type.Optional(Limit), before: Type.Optional(Cursor) },
	closed
);
export type ListActivityInput = Static<typeof ListActivityInput>;

export interface ActivityItem {
	issueKey: string;
	kind: ItemKind;
	outcome: ActivityOutcome;
	/** Latest delivery, action or decision. */
	updatedAt: number;
	/** From the item's `issues` / `pull_request` delivery, if any. */
	issue: IssueSummary | null;
	/** The decision (verdicts row), once made. */
	decision: { verdict: VerdictValue; reason: string; decidedAt: number } | null;
	/** The GitHub action (outbox row: comment + close), if any. */
	action: { state: OutboxState; attempts: number; lastError: string | null; updatedAt: number } | null;
	/** The newest delivery for the item. */
	latestDelivery: { deliveryId: string; event: string; action: string | null; state: InboxState; ignoreReason: string | null; receivedAt: number } | null;
}

/** `limit` after defaults: what the Backend receives. */
export type Resolved<T extends { limit?: number }> = Omit<T, 'limit'> & { limit: number };

export const GetIssueInput = Type.Object({ issueKey: IssueKey }, closed);
export type GetIssueInput = Static<typeof GetIssueInput>;

export interface IssueDetail {
	issueKey: string;
	repoId: number;
	number: number;
	/** From the newest `issues` inbox row for this key; null if none parses. */
	issue: IssueSummary | null;
	/** Every inbox row with this issue_key, newest first. */
	deliveries: DeliverySummary[];
	effect: EffectSummary | null;
	verdict: VerdictSummary | null;
	/** Live inspection of `issue/<issueKey>` if resident, else null. */
	actor: ActorDetail | null;
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** A live actor (`host.actors()` and `actor.get()`/`state()`, ADR 0300). */
export interface ActorSummary {
	/** Null for an anonymous actor. */
	address: ActorAddress | null;
	/** `family/name`, or `#<sessionId>` when anonymous. Stable key for UI lists. */
	id: string;
	/** The chart's name (same as address.family for named actors). */
	family: string;
	/** The chart's version: the host segment its image was added as. */
	segment: number;
	/** Session id (bigint) as a decimal string. */
	sessionId: string;
	/** Active atomic states, from `actor.state()`. */
	activeStates: string[];
	/** Pending delayed sends. */
	delayedSendCount: number;
	/** Events waiting in its queue. */
	mailboxDepth: number;
	/** Services it runs. */
	invocations: number;
}

export interface DelayedSendSummary {
	id: string | null;
	event: string;
	/** Epoch ms. */
	due: number;
}

export interface ActorDetail extends ActorSummary {
	/** JSON-safe copy of the actor's variables (e.g. `IssueActorData`). */
	data: unknown;
	delayedSends: DelayedSendSummary[];
}

// ---------------------------------------------------------------------------
// Actor inspector (ADR 0056)
// ---------------------------------------------------------------------------

/** `inspectActor` input: the named actor to snapshot. */
export const InspectActorInput = Type.Object({ address: ActorAddress }, closed);
export type InspectActorInput = Static<typeof InspectActorInput>;

export type ChartStateKind = 'atomic' | 'compound' | 'parallel' | 'final' | 'history_shallow' | 'history_deep';

/** Where a chart element was written. Currently always null (see ADR 0056). */
export interface ChartSource {
	file: string;
	line: number;
}

export interface ChartTransition {
	/** null: eventless (`always`). */
	event: string | null;
	targets: string[];
	kind: 'external' | 'internal';
	/** Guard source (trimmed), or null when unguarded. */
	condition: string | null;
	/** One line per executable-content action, e.g. `assign phase`, `send github.close via github`. */
	actions: string[];
	source: ChartSource | null;
}

export interface ChartState {
	id: string;
	kind: ChartStateKind;
	/** Initial child targets of a compound state. */
	initial: string[];
	transitions: ChartTransition[];
	onentry: string[];
	onexit: string[];
	invokes: string[];
	source: ChartSource | null;
	children: ChartState[];
}

/** The statechart structure of a definition, from the builder spec kept at define time. */
export interface ChartStructure {
	family: string;
	revision: string;
	name: string | null;
	/** The actor file whose builder defines the chart (one file per actor). */
	sourceFile: string;
	datamodel: string;
	initial: string[];
	/** Declared top-level data names. */
	data: string[];
	states: ChartState[];
}

/**
 * What the host says about one live actor (`actor.state()`, `context()`,
 * `get()`, ADR 0300), JSON-safe: bigints as decimal strings, deep or large
 * values cut with `"…"` markers.
 */
export interface ActorSnapshot extends ActorSummary {
	/** Epoch ms when the snapshot was taken. */
	capturedAt: number;
	/** The active configuration as `actor.state()` gives it: a state id, or `{compound: child}`. */
	state: unknown;
	/** What each history state would return to. */
	history: unknown;
	data: unknown;
	delayedSends: DelayedSendSummary[];
	/** null when the chart is not one granary builds. */
	chart: ChartStructure | null;
	/** Set for `issue/<key>` actors: link target for the issue page. */
	issueKey: string | null;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface AllowedUser {
	login: string;
	/** ADR 0311: '' = every repository, `<owner>`, or `<owner>/<repo>` (lower-cased). */
	scope: string;
	/** Why, e.g. the introduction that let them in; null for entries added by hand. */
	note: string | null;
	addedBy: string | null;
	addedAt: number;
}

/** An allowlist scope as typed: empty = everywhere, `owner`, or `owner/repo` (ADR 0311). */
export const AllowScope = Type.String({
	pattern: '^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(/[A-Za-z0-9._-]{1,100})?)?$',
	maxLength: 140,
	description: 'empty = every repository; an owner; or owner/repo'
});

/** `addAllowedUser` form fields; `scope` empty/absent = everywhere. */
export const AddAllowedUserInput = Type.Object({ login: Login, scope: Type.Optional(AllowScope) }, closed);
export type AddAllowedUserInput = Static<typeof AddAllowedUserInput>;

export const RemoveAllowedUserInput = Type.Object({ login: Type.String({ minLength: 1 }), scope: Type.Optional(Type.String({ maxLength: 140 })) }, closed);
export type RemoveAllowedUserInput = Static<typeof RemoveAllowedUserInput>;

export interface AddAllowedUserResult {
	user: AllowedUser;
	/** false when the login was already on the list (idempotent). */
	added: boolean;
}

export interface RemoveAllowedUserResult {
	login: string;
	scope: string;
	/** false when the login was not on the list. */
	removed: boolean;
}

// ---------------------------------------------------------------------------
// Blocklist (ADR 0260): beats the allowlist and maintainer associations
// ---------------------------------------------------------------------------

export interface BlockedUser {
	login: string;
	note: string | null;
	/** Epoch ms; null = blocked until removed. */
	expiresAt: number | null;
	addedBy: string | null;
	addedAt: number;
	/** false once `expiresAt` has passed (kept in the list, no longer enforced). */
	active: boolean;
	/** The login is a granary admin: their own issues/PRs will be closed while active. */
	isAdmin: boolean;
}

/** Block durations offered in the UI; `forever` = until removed. */
export const BlockDuration = Type.Union([
	Type.Literal('1h'),
	Type.Literal('1d'),
	Type.Literal('7d'),
	Type.Literal('forever')
]);
export type BlockDuration = Static<typeof BlockDuration>;

export const BLOCK_DURATION_MS: Record<BlockDuration, number | null> = {
	'1h': 3_600_000,
	'1d': 86_400_000,
	'7d': 7 * 86_400_000,
	forever: null
};

/** `blockUser` form fields. */
export const BlockUserInput = Type.Object(
	{
		login: Login,
		duration: BlockDuration,
		note: Type.Optional(Type.String({ maxLength: 200 }))
	},
	closed
);
export type BlockUserInput = Static<typeof BlockUserInput>;

export const UnblockUserInput = Type.Object({ login: Type.String({ minLength: 1 }) }, closed);
export type UnblockUserInput = Static<typeof UnblockUserInput>;

/** The Backend call behind the form, the CLI and the admin socket. */
export interface BlockUserRequest {
	login: string;
	note: string | null;
	/** Milliseconds from now; null = until removed. */
	forMs: number | null;
}

export interface BlockUserResult {
	user: BlockedUser;
	/** false when the login was already blocked (its note/expiry were replaced). */
	added: boolean;
}

export interface UnblockUserResult {
	login: string;
	/** false when the login was not blocked. */
	removed: boolean;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export const RetryEffectInput = Type.Object({ effectKey: EffectKey }, closed);
export type RetryEffectInput = Static<typeof RetryEffectInput>;

// Re-exports used by consumers of this module.
export { ActorAddress };

// ---------------------------------------------------------------------------
// Introductions (ADR 0310)
// ---------------------------------------------------------------------------

export const INTRODUCTION_STATES = ['pending', 'approving', 'approved', 'declined', 'withdrawn', 'failed'] as const;
export type IntroductionStateName = (typeof INTRODUCTION_STATES)[number];

export interface IntroductionClosedItem {
	kind: ItemKind;
	issueKey: string;
	owner: string;
	repo: string;
	number: number;
	title: string;
	htmlUrl: string;
}

export interface IntroductionSummary {
	introKey: string;
	owner: string;
	repo: string;
	number: number;
	author: string;
	association: string | null;
	title: string;
	body: string;
	htmlUrl: string;
	/** `owner/repo` or `owner` (an org-level introduction). */
	scope: string;
	state: IntroductionStateName;
	receivedAt: number;
	updatedAt: number;
	decidedBy: string | null;
	decidedAt: number | null;
	note: string | null;
	/** What the policy says about the author there now. */
	policy: { allowed: boolean; reason: string };
	/** What granary closed on them in the scope (an approval reopens these). */
	closedItems: IntroductionClosedItem[];
	/** What the approval reopened (from its action). */
	reopened: IntroductionClosedItem[];
	/** The approval's GitHub action, once there is one. */
	action: { state: OutboxState; attempts: number; lastError: string | null; effectKey: string } | null;
}

export interface IntroductionCounts {
	pending: number;
	approving: number;
	approved: number;
	declined: number;
	withdrawn: number;
	failed: number;
}

export const ListIntroductionsInput = Type.Object(
	{ state: Type.Optional(Type.Union(INTRODUCTION_STATES.map((s) => Type.Literal(s)))) },
	closed
);
export type ListIntroductionsInput = Static<typeof ListIntroductionsInput>;

export const IntroductionKeyInput = Type.Object({ introKey: IssueKey }, closed);
export type IntroductionKeyInput = Static<typeof IntroductionKeyInput>;

export const DeclineIntroductionInput = Type.Object(
	{ introKey: IssueKey, note: Type.Optional(Type.String({ maxLength: 2000 })) },
	closed
);
export type DeclineIntroductionInput = Static<typeof DeclineIntroductionInput>;

export type DiscussionSetupStateName = 'ready' | 'no-category' | 'disabled' | 'no-access' | 'missing' | 'error' | 'unchecked';

export interface IntroductionSetupEntry {
	owner: string;
	repo: string;
	/** The owner's org discussions repository: its introductions are about every repository of the owner. */
	org: boolean;
	state: DiscussionSetupStateName;
	error: string | null;
	checkedAt: number | null;
	/** Where people start an introduction (when ready). */
	newUrl: string | null;
	/** GitHub pages for the next step. */
	settingsUrl: string;
	newCategoryUrl: string;
}

export interface IntroductionSetupStatus {
	connected: boolean;
	/** Whether the app asks for, and each installation accepted, Discussions (null: unknown yet). */
	access: {
		appPermission: boolean;
		appEvent: boolean;
		pendingInstallations: { installationId: number; account: string }[];
		permissionsUrl: string;
		ready: boolean;
	} | null;
	entries: IntroductionSetupEntry[];
	/** Each owner's org discussions repository when not `.github`. */
	orgRepositories: Record<string, string>;
	category: { name: string; slug: string; emoji: string; description: string };
	approvedTemplate: { template: string; custom: boolean; default: string };
}

export const SetOrgRepositoryInput = Type.Object(
	{ owner: Login, repo: Type.Union([Type.String({ pattern: '^[A-Za-z0-9_.-]{1,100}$' }), Type.Null()]) },
	closed
);
export type SetOrgRepositoryInput = Static<typeof SetOrgRepositoryInput>;

export const SaveApprovedTemplateInput = Type.Object({ template: Type.Union([Type.String({ maxLength: 60_000 }), Type.Null()]) }, closed);
export type SaveApprovedTemplateInput = Static<typeof SaveApprovedTemplateInput>;
