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

/** The signed-in user (also `App.Locals.user`). `isAdmin` is computed per request from `ADMINS`. */
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
	/** Resident actors (`system.actors()` count). */
	residentActors: number;
	/** Resident actors per family, e.g. `{issue: 3, allowlist: 1}`. */
	actorsByFamily: Record<string, number>;
	/** `system.stats().messages.queued` */
	queuedMessages: number;
	/** `system.stats().messages.delivered` */
	deliveredMessages: number;
	/** `system.stats().messages.deadLetters` */
	deadLetters: number;
	/** `system.stats().memory.total.bytesInUse` */
	memoryBytes: number;
	/** Epoch ms when the actor system was started. */
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

/** Issue facts extracted from a stored `issues` webhook payload. */
export interface IssueSummary {
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
	{ state: Type.Optional(InboxState), limit: Type.Optional(Limit), before: Type.Optional(Cursor) },
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

export type ActorResidency = 'idle' | 'running' | 'done';
export type ActorScheduling = 'none' | 'idle' | 'ready' | 'runnable' | 'quarantined';

/** A resident actor (`system.actors()` → `ActorInspection`, simplified). */
export interface ActorSummary {
	/** Null for an anonymous actor. */
	address: ActorAddress | null;
	/** `family/name`, or `#<sessionId>` when anonymous. Stable key for UI lists. */
	id: string;
	/** Definition identity family (same as address.family for named actors). */
	family: string;
	revision: string;
	/** Session id (bigint) as a decimal string. */
	sessionId: string;
	activeStates: string[];
	residency: ActorResidency;
	scheduling: ActorScheduling;
	macrostepInProgress: boolean;
	/** `inspection.step.macrostep` / `.microstep` */
	macrostep: number;
	microstep: number;
	finalState: string | null;
	delayedSendCount: number;
	/** `system.mailbox(actor).length` */
	mailboxDepth: number;
	allocatedBytes: number;
}

export interface DelayedSendSummary {
	id: string | null;
	event: string;
	/** Epoch ms. */
	due: number;
}

export interface QueuedMessageSummary {
	event: string;
	/** JSON-safe copy of the data. */
	data: unknown;
}

export interface ActorDetail extends ActorSummary {
	/** JSON-safe copy of `actor.data()` (e.g. `IssueActorData`). */
	data: unknown;
	delayedSends: DelayedSendSummary[];
	mailbox: QueuedMessageSummary[];
	/** Name of the event being processed, if a macrostep is in progress. */
	currentEvent: string | null;
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

export interface SnapshotEvent {
	name: string;
	type: 'external' | 'internal' | 'platform';
	sendId: string | null;
	/** Origin URI or a short description of who sent it. */
	origin: string | null;
	data: unknown;
}

export interface SnapshotQueuedMessage {
	event: string;
	data: unknown;
	/** A send() waits for it. */
	awaited: boolean;
	/** Operator transition carried by the message, as `source → targets`. */
	transition: string | null;
}

export interface SnapshotDelayedSend {
	id: string | null;
	event: string;
	/** Epoch ms. */
	due: number;
	ioType: string;
	/** `self`, `family/name`, `#slot:gen`, or null for custom processors. */
	destination: string | null;
	target: unknown;
	data: unknown;
	/** The router refused it once; waiting to be offered again. */
	submitted: boolean;
}

export interface SnapshotInvocation {
	id: string;
	type: string;
	active: boolean;
	autoforward: boolean;
	serviceHandle: string;
}

/**
 * Everything `ActorInspection` (+ mailbox, definition inspection, chart
 * structure) says about one resident actor, JSON-safe. Sets are shown as
 * `{ "$set": [...] }`, Maps as `{ "$map": {...} }`, functions as
 * `"[Function name]"`, cycles as `"[Circular]"`; deep/large values are cut
 * with `"…"` markers.
 */
export interface ActorSnapshot extends ActorSummary {
	/** Epoch ms when the snapshot was taken. */
	capturedAt: number;
	runtime: { slot: number; generation: number };
	definition: {
		id: string;
		family: string;
		revision: string;
		name: string | null;
		datamodel: string;
		binding: 'early' | 'late';
		stateCount: number;
		actorCount: number;
		retired: boolean;
	};
	published: boolean;
	microstepInProgress: boolean;
	position: {
		at: string;
		state: string | null;
		transition: number | null;
		action: number | null;
		iteration: number;
	};
	currentEvent: SnapshotEvent | null;
	internalEvents: SnapshotEvent[];
	mailbox: SnapshotQueuedMessage[];
	/** More messages were waiting than listed. */
	mailboxTruncated: boolean;
	delayedSends: SnapshotDelayedSend[];
	invocations: SnapshotInvocation[];
	data: unknown;
	completion: unknown;
	/** null when the definition was not built by a known chart (or its revision changed). */
	chart: ChartStructure | null;
	/** Set for `issue/<key>` actors: link target for the issue page. */
	issueKey: string | null;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface AllowedUser {
	login: string;
	addedBy: string | null;
	addedAt: number;
}

/** `addAllowedUser` form fields. */
export const AddAllowedUserInput = Type.Object({ login: Login }, closed);
export type AddAllowedUserInput = Static<typeof AddAllowedUserInput>;

export const RemoveAllowedUserInput = Type.Object({ login: Type.String({ minLength: 1 }) }, closed);
export type RemoveAllowedUserInput = Static<typeof RemoveAllowedUserInput>;

export interface AddAllowedUserResult {
	user: AllowedUser;
	/** false when the login was already on the list (idempotent). */
	added: boolean;
}

export interface RemoveAllowedUserResult {
	login: string;
	/** false when the login was not on the list. */
	removed: boolean;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export const RetryEffectInput = Type.Object({ effectKey: EffectKey }, closed);
export type RetryEffectInput = Static<typeof RetryEffectInput>;

// Re-exports used by consumers of this module.
export { ActorAddress };
