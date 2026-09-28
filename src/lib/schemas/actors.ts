/**
 * Message protocol between actors, the `github` I/O processor, the outbox
 * relay and the webhook route. Every event name and every event's `data`
 * shape lives here. ADR 0002, ADR 0033.
 *
 * Relative imports only (no `$lib`).
 */
import { Type, type Static } from '@sinclair/typebox';
import { AuthorAssociation, Nullable } from './github';
import { parse } from './standard';

const closed = { additionalProperties: false } as const;

// ---------------------------------------------------------------------------
// Addresses and keys
// ---------------------------------------------------------------------------

export const ActorAddress = Type.Object(
	{ family: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) },
	{ ...closed, title: 'ActorAddress' }
);
export type ActorAddress = Static<typeof ActorAddress>;

export const FAMILY = { issue: 'issue', allowlist: 'allowlist' } as const;

/** `allowlist/main`, spawned at boot. */
export const ALLOWLIST_ADDRESS: ActorAddress = Object.freeze({ family: FAMILY.allowlist, name: 'main' });

/** Issue key: `<repository.id>-<issue.number>`, e.g. `123456-42`. Used as the issue actor's name and in `inbox.issue_key` / `outbox.issue_key` / `verdicts.issue_key`. */
export const IssueKey = Type.String({ pattern: '^[0-9]+-[0-9]+$', title: 'issue key' });
export type IssueKey = Static<typeof IssueKey>;

export const issueKey = (repoId: number, number: number): string => `${repoId}-${number}`;

export function parseIssueKey(key: string): { repoId: number; number: number } {
	const m = /^([0-9]+)-([0-9]+)$/.exec(key);
	if (!m) throw new Error(`Invalid issue key: ${key}`);
	return { repoId: Number(m[1]), number: Number(m[2]) };
}

/** `issue/<repoId>-<number>` */
export const issueAddress = (repoId: number, number: number): ActorAddress => ({
	family: FAMILY.issue,
	name: issueKey(repoId, number)
});

export const issueAddressFromKey = (key: string): ActorAddress => ({ family: FAMILY.issue, name: key });

/** Outbox effect key for closing an issue: `close:<repoId>:<number>`. */
export const EffectKey = Type.String({ pattern: '^close:[0-9]+:[0-9]+$', title: 'effect key' });
export type EffectKey = Static<typeof EffectKey>;
export const closeEffectKey = (repoId: number, number: number): string => `close:${repoId}:${number}`;

/** `family/name` (display form, also the DAP `address` attach argument). */
export const formatAddress = (a: ActorAddress): string => `${a.family}/${a.name}`;

export function parseAddress(text: string): ActorAddress {
	const i = text.indexOf('/');
	if (i <= 0 || i === text.length - 1) throw new Error(`Invalid actor address: ${text}`);
	return { family: text.slice(0, i), name: text.slice(i + 1) };
}

/** SCXML send target URI for an address: `#_actor_<family>/<name>`. */
export const actorTargetUri = (a: ActorAddress): string => `#_actor_${a.family}/${a.name}`;

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const EVENTS = {
	/** webhook route / boot re-post / sweeper → issue/<key> */
	issueOpened: 'issue.opened',
	/** issue/<key> → allowlist/main */
	allowlistCheck: 'allowlist.check',
	/** allowlist/main → event.origin (the issue actor) */
	allowlistVerdict: 'allowlist.verdict',
	/** backend (after writing allowed_users) → allowlist/main */
	allowlistReplace: 'allowlist.replace',
	/** issue/<key> → `github` I/O processor (`<send type="github">`) */
	githubClose: 'github.close',
	/** github I/O processor (already done) or outbox relay → reply_to (issue/<key>) */
	githubClosed: 'github.closed',
	/** outbox relay → reply_to (issue/<key>), after 6 failed attempts */
	githubGaveUp: 'github.gave-up',
	/** issue/<key> → itself, delayed CHECK_TIMEOUT_MS, send id CHECK_TIMEOUT_SEND_ID */
	checkTimeout: 'check.timeout'
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** I/O processor type used for GitHub side effects. */
export const GITHUB_IO_TYPE = 'github';
/** Allowlist check timeout (ADR 0002). */
export const CHECK_TIMEOUT_MS = 10_000;
/** `<send id>` of the check timeout, so it can be cancelled. */
export const CHECK_TIMEOUT_SEND_ID = 'check-timeout';
/** Relay gives up after this many attempts (ADR 0003). */
export const MAX_EFFECT_ATTEMPTS = 6;

// ---------------------------------------------------------------------------
// Event data
// ---------------------------------------------------------------------------

/**
 * `issue.opened` — derived from an `issues`/`opened` webhook (inbox row).
 * Posted with `system.post(issueAddress(repoId, number), 'issue.opened', data)`.
 */
export const IssueOpenedData = Type.Object(
	{
		deliveryId: Type.String({ minLength: 1 }),
		issueKey: IssueKey,
		repoId: Type.Integer(),
		owner: Type.String(),
		repo: Type.String(),
		number: Type.Integer({ minimum: 1 }),
		author: Type.String(),
		authorType: Type.String({ description: "GitHub user.type: 'User' | 'Bot' | …" }),
		association: AuthorAssociation,
		title: Type.String(),
		htmlUrl: Type.String()
	},
	{ ...closed, title: 'issue.opened' }
);
export type IssueOpenedData = Static<typeof IssueOpenedData>;

/** `allowlist.check` — reply goes to the event's origin. */
export const AllowlistCheckData = Type.Object(
	{ login: Type.String(), association: AuthorAssociation },
	{ ...closed, title: 'allowlist.check' }
);
export type AllowlistCheckData = Static<typeof AllowlistCheckData>;

/**
 * Why a login was allowed or not. `allowlist`: login is in allowed_users;
 * `association`: OWNER/MEMBER/COLLABORATOR; `not-allowed`: neither.
 */
export const AllowlistReason = Type.Union([
	Type.Literal('allowlist'),
	Type.Literal('association'),
	Type.Literal('not-allowed')
]);
export type AllowlistReason = Static<typeof AllowlistReason>;

/** `allowlist.verdict` */
export const AllowlistVerdictData = Type.Object(
	{ login: Type.String(), allowed: Type.Boolean(), reason: AllowlistReason },
	{ ...closed, title: 'allowlist.verdict' }
);
export type AllowlistVerdictData = Static<typeof AllowlistVerdictData>;

/** `allowlist.replace` — the full new set (as stored in allowed_users). */
export const AllowlistReplaceData = Type.Object(
	{ logins: Type.Array(Type.String()) },
	{ ...closed, title: 'allowlist.replace' }
);
export type AllowlistReplaceData = Static<typeof AllowlistReplaceData>;

/**
 * `github.close` — sent by the issue actor to the `github` I/O processor.
 * Identical to the outbox row's `payload` column (`OutboxPayload` in wal.ts).
 * The processor derives `effect_key = close:<repoId>:<number>` and
 * `reply_to = request.source` (the issue actor's address).
 */
export const GitHubCloseData = Type.Object(
	{
		repoId: Type.Integer(),
		owner: Type.String(),
		repo: Type.String(),
		number: Type.Integer({ minimum: 1 }),
		author: Type.String(),
		association: AuthorAssociation,
		title: Type.String(),
		htmlUrl: Type.String(),
		deliveryId: Type.String()
	},
	{ ...closed, title: 'github.close' }
);
export type GitHubCloseData = Static<typeof GitHubCloseData>;

/** `github.closed` — the effect is done (comment posted, issue closed). */
export const GitHubClosedData = Type.Object(
	{ effectKey: EffectKey, commentId: Nullable(Type.Integer()) },
	{ ...closed, title: 'github.closed' }
);
export type GitHubClosedData = Static<typeof GitHubClosedData>;

/** `github.gave-up` — outbox row went `dead`. */
export const GitHubGaveUpData = Type.Object(
	{ effectKey: EffectKey, attempts: Type.Integer(), lastError: Type.String() },
	{ ...closed, title: 'github.gave-up' }
);
export type GitHubGaveUpData = Static<typeof GitHubGaveUpData>;

/** `check.timeout` carries no data (`undefined`). */
export const CheckTimeoutData = Type.Undefined({ title: 'check.timeout' });
export type CheckTimeoutData = Static<typeof CheckTimeoutData>;

/** Event name → data schema. */
export const EVENT_DATA = {
	[EVENTS.issueOpened]: IssueOpenedData,
	[EVENTS.allowlistCheck]: AllowlistCheckData,
	[EVENTS.allowlistVerdict]: AllowlistVerdictData,
	[EVENTS.allowlistReplace]: AllowlistReplaceData,
	[EVENTS.githubClose]: GitHubCloseData,
	[EVENTS.githubClosed]: GitHubClosedData,
	[EVENTS.githubGaveUp]: GitHubGaveUpData,
	[EVENTS.checkTimeout]: CheckTimeoutData
} as const;

export interface EventDataMap {
	'issue.opened': IssueOpenedData;
	'allowlist.check': AllowlistCheckData;
	'allowlist.verdict': AllowlistVerdictData;
	'allowlist.replace': AllowlistReplaceData;
	'github.close': GitHubCloseData;
	'github.closed': GitHubClosedData;
	'github.gave-up': GitHubGaveUpData;
	'check.timeout': CheckTimeoutData;
}

/** Validate an event's data against its schema; throws SchemaValidationError. */
export function parseEventData<E extends EventName>(event: E, data: unknown): EventDataMap[E] {
	return parse(EVENT_DATA[event], data, `${event} data`) as EventDataMap[E];
}

// ---------------------------------------------------------------------------
// Issue actor: data, loader binding, done-data
// ---------------------------------------------------------------------------

export const IssuePhase = Type.Union([Type.Literal('new'), Type.Literal('closing'), Type.Literal('settled')]);
export type IssuePhase = Static<typeof IssuePhase>;

/**
 * The issue family loader's binding (`{ spawn, binding }`), from SQLite:
 * verdict row → `settled`; outbox row → `closing` + `issue` rebuilt from the
 * outbox payload and the pending inbox row; otherwise `new` (no issue).
 */
export const IssueLoaderBinding = Type.Object(
	{
		issueKey: IssueKey,
		phase: IssuePhase,
		issue: Type.Optional(IssueOpenedData)
	},
	{ ...closed, title: 'IssueLoaderBinding' }
);
export type IssueLoaderBinding = Static<typeof IssueLoaderBinding>;

/** Final verdict reported by the issue actor's done-data. */
export const IssueOutcome = Type.Union([
	Type.Literal('allowed'),
	Type.Literal('closed'),
	Type.Literal('failed'),
	Type.Literal('settled')
]);
export type IssueOutcome = Static<typeof IssueOutcome>;

/**
 * Reason strings in done-data / verdicts.reason:
 * - allowed: `allowlist` | `association`
 * - closed:  `not-allowed`
 * - failed:  `github-gave-up: <lastError>` | `check-timeout`
 * - settled: `already-settled`
 */
export const OUTCOME_REASONS = {
	allowlist: 'allowlist',
	association: 'association',
	notAllowed: 'not-allowed',
	checkTimeout: 'check-timeout',
	alreadySettled: 'already-settled',
	gaveUp: (lastError: string) => `github-gave-up: ${lastError}`
} as const;

/** The issue actor's data model. */
export const IssueActorData = Type.Object(
	{
		issueKey: IssueKey,
		phase: IssuePhase,
		/** Set by `issue.opened` (or the loader binding when `closing`). */
		issue: Nullable(IssueOpenedData),
		/** Delivery that triggered the current run; reported in done-data. */
		deliveryId: Nullable(Type.String()),
		verdict: Nullable(IssueOutcome),
		reason: Nullable(Type.String())
	},
	{ ...closed, title: 'IssueActorData' }
);
export type IssueActorData = Static<typeof IssueActorData>;

/**
 * Done-data of the issue actor, read by the system `done` hook: it writes
 * `verdicts` (unless `settled`, which never overwrites) and marks inbox row
 * `deliveryId` `done` in one transaction.
 */
export const IssueDoneData = Type.Object(
	{
		issueKey: IssueKey,
		deliveryId: Nullable(Type.String()),
		verdict: IssueOutcome,
		reason: Type.String()
	},
	{ ...closed, title: 'IssueDoneData' }
);
export type IssueDoneData = Static<typeof IssueDoneData>;

export const parseIssueDoneData = (value: unknown): IssueDoneData => parse(IssueDoneData, value, 'issue done-data');

// ---------------------------------------------------------------------------
// Allowlist actor
// ---------------------------------------------------------------------------

/** `allowlist/main` data; binding at spawn = logins from allowed_users, lower-cased. */
export const AllowlistActorData = Type.Object(
	{ logins: Type.Array(Type.String()) },
	{ ...closed, title: 'AllowlistActorData' }
);
export type AllowlistActorData = Static<typeof AllowlistActorData>;
