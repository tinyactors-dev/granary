/**
 * Row types of the SQLite write-ahead log (ADR 0003) and the JSON payloads
 * stored in its TEXT columns. Column names are snake_case exactly as in the
 * tables; timestamps are INTEGER milliseconds since the epoch.
 * ADR 0003, ADR 0033.
 *
 * Relative imports only (no `$lib`).
 */
import { Type, type Static } from '@sinclair/typebox';
import { ActorAddress, EffectKey, GitHubCloseData, IssueKey, ItemKind } from './actors';
import { IssuesWebhookPayload, Nullable } from './github';
import { parse, parseJson, stringifyJson } from './standard';
import { MAX_RENDERED_LENGTH } from './message-template';

const closed = { additionalProperties: false } as const;

/** Milliseconds since the epoch. */
export const EpochMs = Type.Integer({ minimum: 0, title: 'epoch ms' });
export type EpochMs = Static<typeof EpochMs>;

// ---------------------------------------------------------------------------
// State enums
// ---------------------------------------------------------------------------

export const InboxState = Type.Union([
	Type.Literal('pending'),
	Type.Literal('done'),
	Type.Literal('failed'),
	Type.Literal('ignored')
]);
export type InboxState = Static<typeof InboxState>;
export const INBOX_STATES: readonly InboxState[] = ['pending', 'done', 'failed', 'ignored'];

export const OutboxState = Type.Union([
	Type.Literal('pending'),
	Type.Literal('inflight'),
	Type.Literal('done'),
	Type.Literal('dead')
]);
export type OutboxState = Static<typeof OutboxState>;
export const OUTBOX_STATES: readonly OutboxState[] = ['pending', 'inflight', 'done', 'dead'];

/** Values stored in `verdicts.verdict` (done-data `settled` never writes a row). */
export const VerdictValue = Type.Union([Type.Literal('allowed'), Type.Literal('closed'), Type.Literal('failed')]);
export type VerdictValue = Static<typeof VerdictValue>;
export const VERDICT_VALUES: readonly VerdictValue[] = ['allowed', 'closed', 'failed'];

// ---------------------------------------------------------------------------
// JSON column payloads
// ---------------------------------------------------------------------------

/**
 * `inbox.payload`: the raw webhook body text as received. For
 * `event='issues'` it parses as `IssuesWebhookPayload`; other events are
 * stored `ignored` and never parsed.
 */
export const InboxPayload = IssuesWebhookPayload;
export type InboxPayload = Static<typeof InboxPayload>;

/**
 * `outbox.payload` JSON — the `github.close` event data plus the closing
 * comment rendered when the row was enqueued (ADR 0251), so retries post the
 * same text even if the template changes meanwhile. Rows without it (enqueued
 * before templates existed) are rendered by the relay from the current setting.
 */
export const CloseEffectPayload = Type.Composite(
	[GitHubCloseData, Type.Object({ commentBody: Type.Optional(Type.String({ maxLength: MAX_RENDERED_LENGTH })) })],
	{ additionalProperties: false, title: 'outbox.payload (close)' }
);
export type CloseEffectPayload = Static<typeof CloseEffectPayload>;

/** An item granary closed that an approval reopens (ADR 0310). */
export const ReopenItem = Type.Object(
	{ kind: ItemKind, repoId: Type.Integer(), owner: Type.String(), repo: Type.String(), number: Type.Integer({ minimum: 1 }), title: Type.String(), htmlUrl: Type.String() },
	{ additionalProperties: false, title: 'ReopenItem' }
);
export type ReopenItem = Static<typeof ReopenItem>;

/**
 * `outbox.payload` of an `approve:<repoId>:<number>` effect (ADR 0310):
 * everything the relay needs, fixed when the admin approved — the items to
 * reopen and the reply, rendered then, so retries do the same.
 */
export const ApproveEffectPayload = Type.Object(
	{
		effect: Type.Literal('approve'),
		introKey: IssueKey,
		repoId: Type.Integer(),
		owner: Type.String(),
		repo: Type.String(),
		/** The discussion's number and GraphQL node id. */
		number: Type.Integer({ minimum: 1 }),
		nodeId: Type.String(),
		author: Type.String(),
		title: Type.String(),
		htmlUrl: Type.String(),
		/** The allowlist scope granted: `owner/repo` or `owner`. */
		scope: Type.String(),
		by: Type.String(),
		reopen: Type.Array(ReopenItem),
		replyBody: Type.String({ maxLength: MAX_RENDERED_LENGTH })
	},
	{ additionalProperties: false, title: 'outbox.payload (approve)' }
);
export type ApproveEffectPayload = Static<typeof ApproveEffectPayload>;

export const OutboxPayload = Type.Union([CloseEffectPayload, ApproveEffectPayload], { title: 'outbox.payload' });
export type OutboxPayload = Static<typeof OutboxPayload>;
export const isApprovePayload = (p: OutboxPayload): p is ApproveEffectPayload => 'effect' in p && p.effect === 'approve';

/** `outbox.reply_to` JSON — the actor to notify (`issue/<key>`). */
export const ReplyTo = ActorAddress;
export type ReplyTo = Static<typeof ReplyTo>;

export const parseInboxPayload = (text: string): InboxPayload => parseJson(InboxPayload, text, 'inbox.payload');
export const parseOutboxPayload = (text: string): OutboxPayload => parseJson(OutboxPayload, text, 'outbox.payload');
/** A close effect's payload; throws for any other kind. */
export function parseClosePayload(text: string): CloseEffectPayload {
	const p = parseOutboxPayload(text);
	if (isApprovePayload(p)) throw new Error('outbox.payload: an approve effect where a close effect was expected');
	return p;
}
export const encodeOutboxPayload = (p: OutboxPayload): string => stringifyJson(OutboxPayload, p, 'outbox.payload');
export const parseReplyTo = (text: string): ReplyTo => parseJson(ReplyTo, text, 'outbox.reply_to');
export const encodeReplyTo = (a: ReplyTo): string => stringifyJson(ReplyTo, a, 'outbox.reply_to');

// ---------------------------------------------------------------------------
// Rows (as returned by bun:sqlite `.get()` / `.all()`)
// ---------------------------------------------------------------------------

export const InboxRow = Type.Object(
	{
		delivery_id: Type.String(),
		event: Type.String(),
		action: Nullable(Type.String()),
		/** `<repoId>-<number>` for `issues` events, else null. */
		issue_key: Nullable(IssueKey),
		payload: Type.String(),
		received_at: EpochMs,
		state: InboxState,
		/** Why an `ignored` row is not acted on (migration 4, ADR 0220). */
		ignore_reason: Type.Optional(Nullable(Type.String()))
	},
	{ ...closed, title: 'InboxRow' }
);
export type InboxRow = Static<typeof InboxRow>;

export const OutboxRow = Type.Object(
	{
		effect_key: EffectKey,
		issue_key: IssueKey,
		/** JSON `ReplyTo` */
		reply_to: Type.String(),
		/** JSON `OutboxPayload` */
		payload: Type.String(),
		state: OutboxState,
		comment_id: Nullable(Type.Integer()),
		attempts: Type.Integer({ minimum: 0 }),
		next_attempt_at: Nullable(EpochMs),
		last_error: Nullable(Type.String()),
		updated_at: EpochMs
	},
	{ ...closed, title: 'OutboxRow' }
);
export type OutboxRow = Static<typeof OutboxRow>;

export const VerdictRow = Type.Object(
	{ issue_key: IssueKey, verdict: VerdictValue, reason: Type.String(), decided_at: EpochMs },
	{ ...closed, title: 'VerdictRow' }
);
export type VerdictRow = Static<typeof VerdictRow>;

/** `allowed_users` (ADR 0311): `scope` '' = everywhere, `<owner>`, or `<owner>/<repo>`; `note` e.g. the introduction that let them in. */
export const AllowedUserRow = Type.Object(
	{ login: Type.String(), scope: Type.String(), note: Nullable(Type.String()), added_by: Nullable(Type.String()), added_at: EpochMs },
	{ ...closed, title: 'AllowedUserRow' }
);
export type AllowedUserRow = Static<typeof AllowedUserRow>;

/** `blocked_users` (ADR 0260): `expires_at` null = blocked until removed. */
export const BlockedUserRow = Type.Object(
	{ login: Type.String(), note: Nullable(Type.String()), expires_at: Nullable(EpochMs), added_by: Nullable(Type.String()), added_at: EpochMs },
	{ ...closed, title: 'BlockedUserRow' }
);
export type BlockedUserRow = Static<typeof BlockedUserRow>;

export const SessionRow = Type.Object(
	{
		/** Opaque random id (≥ 32 bytes, base64url) — the `granary_session` cookie value. */
		id: Type.String({ minLength: 16 }),
		login: Type.String(),
		avatar_url: Nullable(Type.String()),
		created_at: EpochMs,
		expires_at: EpochMs
	},
	{ ...closed, title: 'SessionRow' }
);
export type SessionRow = Static<typeof SessionRow>;

export const parseInboxRow = (v: unknown): InboxRow => parse(InboxRow, v, 'inbox row');
export const parseOutboxRow = (v: unknown): OutboxRow => parse(OutboxRow, v, 'outbox row');
export const parseVerdictRow = (v: unknown): VerdictRow => parse(VerdictRow, v, 'verdict row');
export const parseAllowedUserRow = (v: unknown): AllowedUserRow => parse(AllowedUserRow, v, 'allowed_users row');
export const parseBlockedUserRow = (v: unknown): BlockedUserRow => parse(BlockedUserRow, v, 'blocked_users row');
export const parseSessionRow = (v: unknown): SessionRow => parse(SessionRow, v, 'session row');

/** `introductions.state` (ADR 0310). */
export const IntroductionState = Type.Union([
	Type.Literal('pending'),
	Type.Literal('approving'),
	Type.Literal('approved'),
	Type.Literal('declined'),
	Type.Literal('withdrawn'),
	Type.Literal('failed')
]);
export type IntroductionState = Static<typeof IntroductionState>;
export const INTRODUCTION_STATES: readonly IntroductionState[] = ['pending', 'approving', 'approved', 'declined', 'withdrawn', 'failed'];

/** `introductions` (ADR 0310): one row per discussion in an Introductions category. */
export const IntroductionRow = Type.Object(
	{
		intro_key: IssueKey,
		repo_id: Type.Integer(),
		owner: Type.String(),
		repo: Type.String(),
		number: Type.Integer({ minimum: 1 }),
		node_id: Type.String(),
		author: Type.String(),
		author_association: Nullable(Type.String()),
		title: Type.String(),
		body: Type.String(),
		html_url: Type.String(),
		/** `owner/repo` (a repository's Introductions) or `owner` (the org discussions repository). */
		scope: Type.String(),
		state: IntroductionState,
		received_at: EpochMs,
		updated_at: EpochMs,
		decided_by: Nullable(Type.String()),
		decided_at: Nullable(EpochMs),
		note: Nullable(Type.String()),
		delivery_id: Nullable(Type.String())
	},
	{ ...closed, title: 'IntroductionRow' }
);
export type IntroductionRow = Static<typeof IntroductionRow>;
export const parseIntroductionRow = (v: unknown): IntroductionRow => parse(IntroductionRow, v, 'introductions row');

/** What granary found when it checked a repository's Discussions (ADR 0310). */
export const DiscussionSetupState = Type.Union([
	Type.Literal('ready'),
	Type.Literal('no-category'),
	Type.Literal('disabled'),
	Type.Literal('no-access'),
	Type.Literal('missing'),
	Type.Literal('error')
]);
export type DiscussionSetupState = Static<typeof DiscussionSetupState>;

/** `discussion_setup` (ADR 0310): the last check per repository. */
export const DiscussionSetupRow = Type.Object(
	{
		/** Lower-cased `owner/repo` (the org discussions repository may not be a gated one). */
		full_name: Type.String(),
		repo_id: Nullable(Type.Integer()),
		state: DiscussionSetupState,
		category_id: Nullable(Type.String()),
		category_slug: Nullable(Type.String()),
		/** Where someone starts an introduction (set when `ready`). */
		new_url: Nullable(Type.String()),
		error: Nullable(Type.String()),
		checked_at: EpochMs
	},
	{ ...closed, title: 'DiscussionSetupRow' }
);
export type DiscussionSetupRow = Static<typeof DiscussionSetupRow>;
export const parseDiscussionSetupRow = (v: unknown): DiscussionSetupRow => parse(DiscussionSetupRow, v, 'discussion_setup row');

/** Session lifetime (ADR 0034): 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
