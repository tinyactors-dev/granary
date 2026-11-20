/**
 * `repository/<repoId>` — one repository's issues and their comments
 * (ADR 0060). Spawned by the host when `registry/main` creates the repo.
 * Produces GitHub-shaped `Issue` / `IssueComment` objects
 * (`src/lib/schemas/github.ts`).
 */
import { handlerChart } from '../../src/lib/charts';
import type {
	AuthorAssociation,
	GitHubUser,
	Issue,
	IssueComment,
	IssueStateReason,
	UpdateIssueRequest
} from '../../src/lib/schemas/github';

export const REPOSITORY_FAMILY = 'repository';
export const repositoryAddress = (repoId: number) => `${REPOSITORY_FAMILY}/${repoId}`;

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
	/** Set for pull requests, which share the issue number sequence (ADR 0282). */
	pullRequest?: { draft: boolean };
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
	/** ADR 0310: Discussions (GraphQL-only on GitHub). Absent in repos spawned before; read with `?? …`. */
	discussionsEnabled?: boolean;
	categories?: StoredCategory[];
	discussions?: StoredDiscussion[];
}

/** A discussion category (ADR 0310). GitHub has no API to create one; the fake's control API does. */
export interface StoredCategory {
	id: number;
	name: string;
	slug: string;
	emoji: string;
	description: string;
	isAnswerable: boolean;
	created_at: string;
}

export interface StoredDiscussion {
	id: number;
	number: number;
	title: string;
	body: string;
	categoryId: number;
	user: GitHubUser;
	author_association: AuthorAssociation;
	created_at: string;
	updated_at: string;
	comments: StoredComment[];
}

export const REPOSITORY_EVENTS = {
	createIssue: 'issue.create',
	getPull: 'pull.get',
	getIssue: 'issue.get',
	updateIssue: 'issue.update',
	reopenIssue: 'issue.reopen',
	createComment: 'comment.create',
	listComments: 'comment.list',
	/** ADR 0310: Discussions. */
	setDiscussions: 'discussions.set-enabled',
	createCategory: 'category.create',
	discussionInfo: 'discussions.info',
	createDiscussion: 'discussion.create',
	updateDiscussion: 'discussion.update',
	deleteDiscussion: 'discussion.delete',
	getDiscussion: 'discussion.get',
	addDiscussionComment: 'discussion.comment'
} as const;

export interface CreateCategoryEvent {
	id: number;
	name: string;
	slug?: string;
	emoji?: string;
	description?: string;
	now: string;
}
export interface CreateDiscussionEvent {
	id: number;
	author: GitHubUser;
	association: AuthorAssociation;
	title: string;
	body: string;
	/** Category slug or name (case-insensitive). */
	category: string;
	now: string;
}
export interface UpdateDiscussionEvent {
	number: number;
	title?: string;
	body?: string;
	category?: string;
	now: string;
}

export interface CreateIssueEvent {
	id: number;
	author: GitHubUser;
	title: string;
	body: string;
	association: AuthorAssociation;
	now: string;
	/** Create a pull request instead of an issue (ADR 0282). */
	pullRequest?: { draft: boolean };
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

function issueUrls(d: RepositoryData, n: number, pull = false) {
	return {
		url: `${d.apiBase}/repos/${d.owner}/${d.name}/issues/${n}`,
		repository_url: `${d.apiBase}/repos/${d.owner}/${d.name}`,
		comments_url: `${d.apiBase}/repos/${d.owner}/${d.name}/issues/${n}/comments`,
		html_url: `${d.webBase}/${d.owner}/${d.name}/${pull ? 'pull' : 'issues'}/${n}`
	};
}

/** GitHub REST shape of a pull request (subset; ADR 0282). */
export function pullView(d: RepositoryData, i: StoredIssue): Record<string, unknown> {
	return {
		id: i.id,
		node_id: `PR_fake${i.id}`,
		number: i.number,
		title: i.title,
		body: i.body,
		state: i.state,
		draft: i.pullRequest?.draft ?? false,
		locked: false,
		user: { ...i.user },
		author_association: i.author_association,
		created_at: i.created_at,
		updated_at: i.updated_at,
		closed_at: i.closed_at,
		merged_at: null,
		url: `${d.apiBase}/repos/${d.owner}/${d.name}/pulls/${i.number}`,
		issue_url: `${d.apiBase}/repos/${d.owner}/${d.name}/issues/${i.number}`,
		html_url: `${d.webBase}/${d.owner}/${d.name}/pull/${i.number}`
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
		...issueUrls(d, i.number, !!i.pullRequest),
		// Issues endpoints return PRs too, marked like on GitHub.
		...(i.pullRequest ? { pull_request: { url: `${d.apiBase}/repos/${d.owner}/${d.name}/pulls/${i.number}`, html_url: `${d.webBase}/${d.owner}/${d.name}/pull/${i.number}` } } : {})
	};
}

export function commentView(d: RepositoryData, i: StoredIssue, c: StoredComment): IssueComment & Record<string, unknown> {
	const urls = issueUrls(d, i.number, !!i.pullRequest);
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

/** `slugify` as GitHub does for category slugs: lower case, runs of other characters → `-`. */
export function categorySlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** GraphQL node ids: the repository id is encoded so a node id alone finds its repository actor. */
export function discussionNodeId(repoId: number, number: number): string {
	return `D_fake${repoId}_${number}`;
}

/** Webhook / GraphQL view of a category (`repository_id` as in the webhook payload). */
export function categoryView(d: RepositoryData, c: StoredCategory): Record<string, unknown> {
	return {
		id: c.id,
		node_id: `DIC_fake${d.id}_${c.id}`,
		repository_id: d.id,
		name: c.name,
		slug: c.slug,
		emoji: c.emoji,
		description: c.description,
		is_answerable: c.isAnswerable,
		created_at: c.created_at,
		updated_at: c.created_at
	};
}

/** The `discussion` object of a `discussion` webhook (subset of GitHub's). */
export function discussionView(d: RepositoryData, x: StoredDiscussion): Record<string, unknown> {
	const c = (d.categories ?? []).find((k) => k.id === x.categoryId);
	return {
		id: x.id,
		node_id: discussionNodeId(d.id, x.number),
		number: x.number,
		title: x.title,
		body: x.body,
		state: 'open',
		locked: false,
		comments: x.comments.length,
		user: { ...x.user },
		author_association: x.author_association,
		created_at: x.created_at,
		updated_at: x.updated_at,
		html_url: `${d.webBase}/${d.owner}/${d.name}/discussions/${x.number}`,
		repository_url: `${d.apiBase}/repos/${d.owner}/${d.name}`,
		category: c ? categoryView(d, c) : null
	};
}

export function discussionCommentView(d: RepositoryData, x: StoredDiscussion, c: StoredComment): Record<string, unknown> {
	return {
		id: c.id,
		node_id: `DC_fake${d.id}_${c.id}`,
		body: c.body,
		user: { ...c.user },
		created_at: c.created_at,
		updated_at: c.updated_at,
		html_url: `${d.webBase}/${d.owner}/${d.name}/discussions/${x.number}#discussioncomment-${c.id}`
	};
}

function findCategory(d: RepositoryData, nameOrSlug: string): StoredCategory | undefined {
	const k = nameOrSlug.toLowerCase();
	return (d.categories ?? []).find((c) => c.slug === k || c.name.toLowerCase() === k);
}

function findDiscussion(d: RepositoryData, n: number): StoredDiscussion | undefined {
	return (d.discussions ?? []).find((x) => x.number === n);
}

/** Chart helpers below are embedded with `Function.prototype.toString`: self-contained. */
function find(d: RepositoryData, n: number) {
	return d.issues.find((i) => i.number === n);
}

export const repositoryChart = handlerChart<RepositoryData>({
	name: REPOSITORY_FAMILY,
	initial: { id: 0, owner: '', ownerId: 0, name: '', webBase: '', apiBase: '', nextNumber: 1, issues: [] },
	helpers: { issueUrls, pullView, issueView, commentView, find, categorySlug, discussionNodeId, categoryView, discussionView, discussionCommentView, findCategory, findDiscussion },
	handlers: {
		[REPOSITORY_EVENTS.createIssue]: (d, e: CreateIssueEvent) => {
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
				comments: [],
				...(e.pullRequest ? { pullRequest: { draft: e.pullRequest.draft } } : {})
			};
			d.issues.push(issue);
			return e.pullRequest ? { issue: issueView(d, issue), pull: pullView(d, issue) } : issueView(d, issue);
		},
		[REPOSITORY_EVENTS.getPull]: (d, e: { number: number }) => {
			const i = find(d, e.number);
			return i?.pullRequest ? pullView(d, i) : { error: 'Not Found', status: 404 };
		},
		[REPOSITORY_EVENTS.getIssue]: (d, e: { number: number }) => {
			const i = find(d, e.number);
			return i ? issueView(d, i) : { error: 'Not Found', status: 404 };
		},
		[REPOSITORY_EVENTS.updateIssue]: (d, e: UpdateIssueEvent) => {
			const i = find(d, e.number);
			if (!i) return { error: 'Not Found', status: 404 };
			const p = e.patch;
			if (p.title !== undefined) i.title = p.title;
			if (p.body !== undefined) i.body = p.body;
			if (p.state === 'closed') {
				if (i.state !== 'closed') i.closed_at = e.now;
				i.state = 'closed';
				// Pull requests have no state_reason on GitHub.
				i.state_reason = i.pullRequest ? null : (p.state_reason ?? 'completed');
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
		},
		[REPOSITORY_EVENTS.reopenIssue]: (d, e: { number: number; now: string }) => {
			const i = find(d, e.number);
			if (!i) return { error: 'Not Found', status: 404 };
			i.state = 'open';
			i.state_reason = 'reopened';
			i.closed_at = null;
			i.updated_at = e.now;
			return issueView(d, i);
		},
		[REPOSITORY_EVENTS.createComment]: (d, e: CreateCommentEvent) => {
			const i = find(d, e.number);
			if (!i) return { error: 'Not Found', status: 404 };
			const c: StoredComment = { id: e.id, body: e.body, user: e.user, created_at: e.now, updated_at: e.now };
			i.comments.push(c);
			i.updated_at = e.now;
			return commentView(d, i, c);
		},
		[REPOSITORY_EVENTS.listComments]: (d, e: { number: number }) => {
			const i = find(d, e.number);
			return i ? i.comments.map((c) => commentView(d, i, c)) : { error: 'Not Found', status: 404 };
		},
		[REPOSITORY_EVENTS.setDiscussions]: (d, e: { enabled: boolean }) => {
			d.discussionsEnabled = e.enabled;
			return { enabled: e.enabled };
		},
		[REPOSITORY_EVENTS.createCategory]: (d, e: CreateCategoryEvent) => {
			if (!d.discussionsEnabled) return { error: 'Discussions are not enabled on this repository', status: 422 };
			const slug = e.slug ?? categorySlug(e.name);
			const existing = findCategory(d, slug) ?? findCategory(d, e.name);
			if (existing) return categoryView(d, existing);
			const c: StoredCategory = {
				id: e.id,
				name: e.name,
				slug,
				emoji: e.emoji ?? ':speech_balloon:',
				description: e.description ?? '',
				isAnswerable: false,
				created_at: e.now
			};
			d.categories = [...(d.categories ?? []), c];
			return categoryView(d, c);
		},
		[REPOSITORY_EVENTS.discussionInfo]: (d) => ({
			enabled: d.discussionsEnabled ?? false,
			categories: (d.categories ?? []).map((c) => categoryView(d, c))
		}),
		[REPOSITORY_EVENTS.createDiscussion]: (d, e: CreateDiscussionEvent) => {
			if (!d.discussionsEnabled) return { error: 'Discussions are not enabled on this repository', status: 422 };
			const c = findCategory(d, e.category);
			if (!c) return { error: `Unknown category ${e.category}`, status: 422 };
			const x: StoredDiscussion = {
				id: e.id,
				number: d.nextNumber++,
				title: e.title,
				body: e.body,
				categoryId: c.id,
				user: e.author,
				author_association: e.association,
				created_at: e.now,
				updated_at: e.now,
				comments: []
			};
			d.discussions = [...(d.discussions ?? []), x];
			return discussionView(d, x);
		},
		[REPOSITORY_EVENTS.updateDiscussion]: (d, e: UpdateDiscussionEvent) => {
			const x = findDiscussion(d, e.number);
			if (!x) return { error: 'Not Found', status: 404 };
			const before = discussionView(d, x);
			if (e.category !== undefined) {
				const c = findCategory(d, e.category);
				if (!c) return { error: `Unknown category ${e.category}`, status: 422 };
				x.categoryId = c.id;
			}
			if (e.title !== undefined) x.title = e.title;
			if (e.body !== undefined) x.body = e.body;
			x.updated_at = e.now;
			return { before, after: discussionView(d, x) };
		},
		[REPOSITORY_EVENTS.deleteDiscussion]: (d, e: { number: number }) => {
			const x = findDiscussion(d, e.number);
			if (!x) return { error: 'Not Found', status: 404 };
			const view = discussionView(d, x);
			d.discussions = (d.discussions ?? []).filter((y) => y.number !== e.number);
			return view;
		},
		[REPOSITORY_EVENTS.getDiscussion]: (d, e: { number: number }) => {
			const x = findDiscussion(d, e.number);
			return x
				? { discussion: discussionView(d, x), comments: x.comments.map((c) => discussionCommentView(d, x, c)) }
				: { error: 'Not Found', status: 404 };
		},
		[REPOSITORY_EVENTS.addDiscussionComment]: (d, e: { number: number; id: number; user: GitHubUser; body: string; now: string }) => {
			const x = findDiscussion(d, e.number);
			if (!x) return { error: 'Not Found', status: 404 };
			const c: StoredComment = { id: e.id, body: e.body, user: e.user, created_at: e.now, updated_at: e.now };
			x.comments.push(c);
			x.updated_at = e.now;
			return discussionCommentView(d, x, c);
		}
	}
});
