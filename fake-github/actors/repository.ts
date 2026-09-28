/**
 * `repository/<repoId>` — one repository's issues and their comments
 * (ADR 0060). Spawned by the host when `registry/main` creates the repo.
 * Produces GitHub-shaped `Issue` / `IssueComment` objects
 * (`src/lib/schemas/github.ts`).
 */
import { statechart } from '@tinyactors/node';
import type {
	AuthorAssociation,
	GitHubUser,
	Issue,
	IssueComment,
	IssueStateReason,
	UpdateIssueRequest
} from '../../src/lib/schemas/github';
import { answer, type ActorFailure } from '../io/reply';

export const REPOSITORY_FAMILY = 'repository';
export const repositoryAddress = (repoId: number) => ({ family: REPOSITORY_FAMILY, name: String(repoId) });

export interface StoredComment {
	id: number;
	body: string;
	user: GitHubUser;
	created_at: string;
	updated_at: string;
}

export interface StoredIssue {
	id: number;
	number: number;
	title: string;
	body: string | null;
	state: 'open' | 'closed';
	state_reason: IssueStateReason | null;
	user: GitHubUser;
	author_association: AuthorAssociation;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	comments: StoredComment[];
}

export interface RepositoryData {
	id: number;
	owner: string;
	ownerId: number;
	name: string;
	/** e.g. `http://localhost:4010` — GitHub web base for `html_url`. */
	webBase: string;
	/** REST base for `url` fields. */
	apiBase: string;
	nextNumber: number;
	issues: StoredIssue[];
	out: unknown;
}

export const REPOSITORY_EVENTS = {
	createIssue: 'issue.create',
	getIssue: 'issue.get',
	updateIssue: 'issue.update',
	reopenIssue: 'issue.reopen',
	createComment: 'comment.create',
	listComments: 'comment.list',
	snapshot: 'repo.snapshot'
} as const;

export interface CreateIssueEvent {
	id: number;
	author: GitHubUser;
	title: string;
	body: string;
	association: AuthorAssociation;
	now: string;
}
export interface UpdateIssueEvent {
	number: number;
	patch: UpdateIssueRequest;
	now: string;
}
export interface CreateCommentEvent {
	number: number;
	id: number;
	user: GitHubUser;
	body: string;
	now: string;
}

const notFound: ActorFailure = { error: 'Not Found', status: 404 };

function issueUrls(d: RepositoryData, n: number) {
	return {
		url: `${d.apiBase}/repos/${d.owner}/${d.name}/issues/${n}`,
		repository_url: `${d.apiBase}/repos/${d.owner}/${d.name}`,
		comments_url: `${d.apiBase}/repos/${d.owner}/${d.name}/issues/${n}/comments`,
		html_url: `${d.webBase}/${d.owner}/${d.name}/issues/${n}`
	};
}

/** GitHub REST shape of an issue (`comments` is the count, as on GitHub). */
export function issueView(d: RepositoryData, i: StoredIssue): Issue & Record<string, unknown> {
	return {
		id: i.id,
		node_id: `I_fake${i.id}`,
		number: i.number,
		title: i.title,
		body: i.body,
		state: i.state,
		state_reason: i.state_reason,
		locked: false,
		labels: [],
		user: { ...i.user },
		author_association: i.author_association,
		comments: i.comments.length,
		created_at: i.created_at,
		updated_at: i.updated_at,
		closed_at: i.closed_at,
		...issueUrls(d, i.number)
	};
}

export function commentView(d: RepositoryData, i: StoredIssue, c: StoredComment): IssueComment & Record<string, unknown> {
	const urls = issueUrls(d, i.number);
	return {
		id: c.id,
		node_id: `IC_fake${c.id}`,
		body: c.body,
		user: { ...c.user },
		author_association: 'NONE',
		created_at: c.created_at,
		updated_at: c.updated_at,
		issue_url: urls.url,
		url: `${d.apiBase}/repos/${d.owner}/${d.name}/issues/comments/${c.id}`,
		html_url: `${urls.html_url}#issuecomment-${c.id}`
	};
}

const find = (d: RepositoryData, n: number) => d.issues.find((i) => i.number === n);

export const repositoryChart = statechart<RepositoryData>({ family: REPOSITORY_FAMILY, revision: 'v1' })
	.data('id', 0)
	.data('owner', '')
	.data('ownerId', 0)
	.data('name', '')
	.data('webBase', '')
	.data('apiBase', '')
	.data('nextNumber', 1)
	.dataExpression('issues', () => [])
	.data('out', null)
	.state('ready', (s) =>
		s
			.on(
				REPOSITORY_EVENTS.createIssue,
				answer<RepositoryData, CreateIssueEvent>((d, e) => {
					const issue: StoredIssue = {
						id: e.id,
						number: d.nextNumber++,
						title: e.title,
						body: e.body,
						state: 'open',
						state_reason: null,
						user: e.author,
						author_association: e.association,
						created_at: e.now,
						updated_at: e.now,
						closed_at: null,
						comments: []
					};
					d.issues.push(issue);
					return issueView(d, issue);
				})
			)
			.on(
				REPOSITORY_EVENTS.getIssue,
				answer<RepositoryData, { number: number }>((d, e) => {
					const i = find(d, e.number);
					return i ? issueView(d, i) : notFound;
				})
			)
			.on(
				REPOSITORY_EVENTS.updateIssue,
				answer<RepositoryData, UpdateIssueEvent>((d, e) => {
					const i = find(d, e.number);
					if (!i) return notFound;
					const p = e.patch;
					if (p.title !== undefined) i.title = p.title;
					if (p.body !== undefined) i.body = p.body;
					if (p.state === 'closed') {
						if (i.state !== 'closed') i.closed_at = e.now;
						i.state = 'closed';
						i.state_reason = p.state_reason ?? 'completed';
					} else if (p.state === 'open') {
						if (i.state !== 'open') i.state_reason = p.state_reason ?? 'reopened';
						else if (p.state_reason !== undefined) i.state_reason = p.state_reason;
						i.state = 'open';
						i.closed_at = null;
					} else if (p.state_reason !== undefined) {
						i.state_reason = p.state_reason;
					}
					i.updated_at = e.now;
					return issueView(d, i);
				})
			)
			.on(
				REPOSITORY_EVENTS.reopenIssue,
				answer<RepositoryData, { number: number; now: string }>((d, e) => {
					const i = find(d, e.number);
					if (!i) return notFound;
					i.state = 'open';
					i.state_reason = 'reopened';
					i.closed_at = null;
					i.updated_at = e.now;
					return issueView(d, i);
				})
			)
			.on(
				REPOSITORY_EVENTS.createComment,
				answer<RepositoryData, CreateCommentEvent>((d, e) => {
					const i = find(d, e.number);
					if (!i) return notFound;
					const c: StoredComment = { id: e.id, body: e.body, user: e.user, created_at: e.now, updated_at: e.now };
					i.comments.push(c);
					i.updated_at = e.now;
					return commentView(d, i, c);
				})
			)
			.on(
				REPOSITORY_EVENTS.listComments,
				answer<RepositoryData, { number: number }>((d, e) => {
					const i = find(d, e.number);
					return i ? i.comments.map((c) => commentView(d, i, c)) : notFound;
				})
			)
	);
