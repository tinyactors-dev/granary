/**
 * GitHub shapes granary reads or writes: the `issues` webhook payload subset,
 * REST issue / comment / user / repository, request bodies, OAuth.
 * ADR 0006, ADR 0031.
 *
 * Inbound GitHub payloads allow additional properties (GitHub sends far more
 * than we model). Request bodies we send are closed (`additionalProperties: false`).
 *
 * Shared with `fake-github/` — relative imports only, no `$lib`.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { parse, parseJson } from './standard';

const open = { additionalProperties: true } as const;
const closed = { additionalProperties: false } as const;

/** `T | null` */
export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A GitHub login: 1–39 alphanumerics or hyphens, not starting with a hyphen,
 * optionally suffixed `[bot]` (e.g. `dependabot[bot]`). Compared case-insensitively.
 */
export const Login = Type.String({
	pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\\[bot\\])?$',
	minLength: 1,
	maxLength: 44,
	title: 'GitHub login',
	errorMessage: 'Not a valid GitHub login'
});
export type Login = Static<typeof Login>;

/** Owner or repository name segment. */
export const RepoName = Type.String({
	pattern: '^[A-Za-z0-9_.-]{1,100}$',
	title: 'repository name',
	errorMessage: 'Not a valid repository or owner name'
});
export type RepoName = Static<typeof RepoName>;

export const AuthorAssociation = Type.Union(
	[
		Type.Literal('OWNER'),
		Type.Literal('MEMBER'),
		Type.Literal('COLLABORATOR'),
		Type.Literal('CONTRIBUTOR'),
		Type.Literal('FIRST_TIME_CONTRIBUTOR'),
		Type.Literal('FIRST_TIMER'),
		Type.Literal('MANNEQUIN'),
		Type.Literal('NONE')
	],
	{ title: 'author_association' }
);
export type AuthorAssociation = Static<typeof AuthorAssociation>;
export const AUTHOR_ASSOCIATIONS: readonly AuthorAssociation[] = [
	'OWNER',
	'MEMBER',
	'COLLABORATOR',
	'CONTRIBUTOR',
	'FIRST_TIME_CONTRIBUTOR',
	'FIRST_TIMER',
	'MANNEQUIN',
	'NONE'
];
/** Associations that are always allowed (ADR 0004). */
export const MAINTAINER_ASSOCIATIONS: readonly AuthorAssociation[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

export const UserType = Type.Union([Type.Literal('User'), Type.Literal('Bot'), Type.Literal('Organization')]);
export type UserType = Static<typeof UserType>;

export const IssueState = Type.Union([Type.Literal('open'), Type.Literal('closed')]);
export type IssueState = Static<typeof IssueState>;

export const IssueStateReason = Type.Union([
	Type.Literal('completed'),
	Type.Literal('not_planned'),
	Type.Literal('reopened'),
	Type.Literal('duplicate')
]);
export type IssueStateReason = Static<typeof IssueStateReason>;

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const GitHubUser = Type.Object(
	{
		login: Type.String(),
		id: Type.Integer(),
		type: Type.String({ description: "'User' | 'Bot' | 'Organization' (kept open)" }),
		avatar_url: Type.Optional(Type.String()),
		html_url: Type.Optional(Type.String())
	},
	{ ...open, title: 'GitHubUser' }
);
export type GitHubUser = Static<typeof GitHubUser>;

export const Repository = Type.Object(
	{
		id: Type.Integer(),
		name: Type.String(),
		full_name: Type.String(),
		owner: Type.Object({ login: Type.String(), id: Type.Optional(Type.Integer()) }, open),
		private: Type.Optional(Type.Boolean()),
		html_url: Type.Optional(Type.String())
	},
	{ ...open, title: 'Repository' }
);
export type Repository = Static<typeof Repository>;

export const Issue = Type.Object(
	{
		id: Type.Integer(),
		number: Type.Integer({ minimum: 1 }),
		title: Type.String(),
		body: Nullable(Type.String()),
		state: IssueState,
		state_reason: Type.Optional(Nullable(IssueStateReason)),
		user: GitHubUser,
		author_association: AuthorAssociation,
		html_url: Type.String(),
		created_at: Type.Optional(Type.String()),
		updated_at: Type.Optional(Type.String()),
		closed_at: Type.Optional(Nullable(Type.String()))
	},
	{ ...open, title: 'Issue' }
);
export type Issue = Static<typeof Issue>;

export const IssueComment = Type.Object(
	{
		id: Type.Integer(),
		body: Type.String(),
		user: GitHubUser,
		html_url: Type.Optional(Type.String()),
		created_at: Type.Optional(Type.String())
	},
	{ ...open, title: 'IssueComment' }
);
export type IssueComment = Static<typeof IssueComment>;

export const IssueCommentList = Type.Array(IssueComment);
export type IssueCommentList = Static<typeof IssueCommentList>;

/** GitHub REST error body. */
export const GitHubErrorBody = Type.Object(
	{ message: Type.String(), documentation_url: Type.Optional(Type.String()) },
	open
);
export type GitHubErrorBody = Static<typeof GitHubErrorBody>;

// ---------------------------------------------------------------------------
// Webhook: `issues` event (X-GitHub-Event: issues)
// ---------------------------------------------------------------------------

/** Header names (lower-case, as `Headers.get` accepts any case). */
export const WEBHOOK_HEADERS = {
	event: 'x-github-event',
	delivery: 'x-github-delivery',
	signature256: 'x-hub-signature-256'
} as const;

/**
 * Known `issues` actions. Kept as a plain string in the payload schema so an
 * unknown action is stored as `ignored`, not rejected.
 */
export const ISSUES_ACTIONS = [
	'opened',
	'edited',
	'deleted',
	'transferred',
	'pinned',
	'unpinned',
	'closed',
	'reopened',
	'assigned',
	'unassigned',
	'labeled',
	'unlabeled',
	'locked',
	'unlocked',
	'milestoned',
	'demilestoned',
	'typed',
	'untyped'
] as const;

export const IssuesWebhookPayload = Type.Object(
	{
		action: Type.String(),
		issue: Issue,
		repository: Repository,
		sender: GitHubUser
	},
	{ ...open, title: 'IssuesWebhookPayload' }
);
export type IssuesWebhookPayload = Static<typeof IssuesWebhookPayload>;

/** Parse a raw `issues` webhook body (text). Throws SchemaValidationError. */
export const parseIssuesWebhook = (body: string): IssuesWebhookPayload =>
	parseJson(IssuesWebhookPayload, body, 'issues webhook payload');

// ---------------------------------------------------------------------------
// REST request bodies (what granary sends)
// ---------------------------------------------------------------------------

/** `POST /repos/{owner}/{repo}/issues/{number}/comments` */
export const CreateCommentRequest = Type.Object({ body: Type.String({ minLength: 1 }) }, closed);
export type CreateCommentRequest = Static<typeof CreateCommentRequest>;

/** `PATCH /repos/{owner}/{repo}/issues/{number}` (granary sends `{state:'closed', state_reason:'not_planned'}`). */
export const UpdateIssueRequest = Type.Object(
	{
		state: Type.Optional(IssueState),
		state_reason: Type.Optional(
			Nullable(Type.Union([Type.Literal('completed'), Type.Literal('not_planned'), Type.Literal('reopened')]))
		),
		title: Type.Optional(Type.String()),
		body: Type.Optional(Nullable(Type.String()))
	},
	closed
);
export type UpdateIssueRequest = Static<typeof UpdateIssueRequest>;

// ---------------------------------------------------------------------------
// OAuth (web flow)
// ---------------------------------------------------------------------------

/** Query of `GET {GITHUB_WEB_URL}/login/oauth/authorize`. `login` is a fake-GitHub-only auto-approve. */
export const OAuthAuthorizeQuery = Type.Object(
	{
		client_id: Type.String({ minLength: 1 }),
		redirect_uri: Type.Optional(Type.String()),
		state: Type.String({ minLength: 1 }),
		scope: Type.Optional(Type.String()),
		login: Type.Optional(Type.String())
	},
	open
);
export type OAuthAuthorizeQuery = Static<typeof OAuthAuthorizeQuery>;

/** Redirect back to the app: `GET {redirect_uri}?code&state`. */
export const OAuthCallbackQuery = Type.Object(
	{ code: Type.String({ minLength: 1 }), state: Type.String({ minLength: 1 }) },
	open
);
export type OAuthCallbackQuery = Static<typeof OAuthCallbackQuery>;

/** Body of `POST {GITHUB_WEB_URL}/login/oauth/access_token` (JSON, `Accept: application/json`). */
export const OAuthAccessTokenRequest = Type.Object(
	{
		client_id: Type.String({ minLength: 1 }),
		client_secret: Type.String({ minLength: 1 }),
		code: Type.String({ minLength: 1 }),
		redirect_uri: Type.Optional(Type.String())
	},
	open
);
export type OAuthAccessTokenRequest = Static<typeof OAuthAccessTokenRequest>;

export const OAuthAccessTokenSuccess = Type.Object(
	{ access_token: Type.String({ minLength: 1 }), token_type: Type.String(), scope: Type.String() },
	open
);
export type OAuthAccessTokenSuccess = Static<typeof OAuthAccessTokenSuccess>;

/** GitHub answers 200 with an error object for a bad/expired code. */
export const OAuthAccessTokenError = Type.Object(
	{
		error: Type.String(),
		error_description: Type.Optional(Type.String()),
		error_uri: Type.Optional(Type.String())
	},
	open
);
export type OAuthAccessTokenError = Static<typeof OAuthAccessTokenError>;

export const OAuthAccessTokenResponse = Type.Union([OAuthAccessTokenSuccess, OAuthAccessTokenError]);
export type OAuthAccessTokenResponse = Static<typeof OAuthAccessTokenResponse>;

/** `GET {GITHUB_API_URL}/user` with `Authorization: Bearer <access_token>`. */
export const AuthenticatedUser = Type.Object(
	{
		login: Type.String(),
		id: Type.Integer(),
		type: Type.String(),
		avatar_url: Type.String(),
		name: Type.Optional(Nullable(Type.String())),
		html_url: Type.Optional(Type.String())
	},
	{ ...open, title: 'AuthenticatedUser' }
);
export type AuthenticatedUser = Static<typeof AuthenticatedUser>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const parseIssue = (value: unknown): Issue => parse(Issue, value, 'issue');
export const parseIssueComment = (value: unknown): IssueComment => parse(IssueComment, value, 'comment');
export const parseIssueCommentList = (value: unknown): IssueCommentList =>
	parse(IssueCommentList, value, 'comment list');
export const parseAuthenticatedUser = (value: unknown): AuthenticatedUser =>
	parse(AuthenticatedUser, value, '/user response');
export const parseOAuthAccessTokenResponse = (value: unknown): OAuthAccessTokenResponse =>
	parse(OAuthAccessTokenResponse, value, 'OAuth access token response');
export const isOAuthAccessTokenError = (r: OAuthAccessTokenResponse): r is OAuthAccessTokenError =>
	'error' in r && typeof r.error === 'string';

/** Case-insensitive login comparison key. */
export const normalizeLogin = (login: string): string => login.toLowerCase();

/** The marker the relay embeds in its closing comment (ADR 0003). */
export const commentMarker = (effectKey: string): string => `<!-- granary:${effectKey} -->`;

/** Default closing comment text (ADR 0004); the relay appends `commentMarker(effectKey)`. */
export const CLOSING_COMMENT =
	'Thanks for the report! Issues in this repository can only be opened by approved contributors, so this one was closed automatically.';
