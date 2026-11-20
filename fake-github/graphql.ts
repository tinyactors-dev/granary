/**
 * `POST /graphql` of the fake GitHub (ADR 0310): the slice of GitHub's
 * GraphQL API granary uses for Discussions, which have no REST API.
 *
 * The schema below is a hand-written subset of GitHub's (same type, field and
 * argument names), executed with graphql-js, so a query granary sends that
 * names a field GitHub does not have fails here as it would there. Data
 * lives in the `repository/<id>` actors; this module resolves and authorizes.
 *
 * Auth as on GitHub: a bearer token (installation `ghs_` or user `ghu_`);
 * an installation token must cover the repository and have the accepted
 * `discussions` permission (`write` for mutations), else the field resolves
 * to null with a FORBIDDEN error ("Resource not accessible by integration").
 * Unknown repositories and discussions are NOT_FOUND errors.
 */
import { buildSchema, graphql, GraphQLError } from 'graphql';
import type { Host } from '@tinyactors/node';
import { askActor } from '../src/lib/charts/runtime';
import type { GitHubUser } from '../src/lib/schemas/github';
import { isFailure } from './failure';
import { nextId } from './ids';
import { repoCovered, type InstallationRecord } from './actors/apps';
import { REPOSITORY_EVENTS, repositoryAddress } from './actors/repository';
import type { FakeUser } from './schemas';
import type { Bases } from './views';

const SDL = /* GraphQL */ `
	scalar URI
	scalar DateTime

	interface Node {
		id: ID!
	}

	interface Actor {
		login: String!
	}

	type User implements Actor & Node {
		id: ID!
		login: String!
	}

	type Bot implements Actor & Node {
		id: ID!
		login: String!
	}

	type PageInfo {
		hasNextPage: Boolean!
		endCursor: String
	}

	type Repository implements Node {
		id: ID!
		databaseId: Int
		name: String!
		nameWithOwner: String!
		url: URI!
		hasDiscussionsEnabled: Boolean!
		discussionCategories(first: Int, after: String): DiscussionCategoryConnection!
		discussion(number: Int!): Discussion
	}

	type DiscussionCategory implements Node {
		id: ID!
		name: String!
		slug: String!
		emoji: String!
		description: String
		isAnswerable: Boolean!
		createdAt: DateTime!
	}

	type DiscussionCategoryConnection {
		nodes: [DiscussionCategory]
		totalCount: Int!
		pageInfo: PageInfo!
	}

	type Discussion implements Node {
		id: ID!
		databaseId: Int
		number: Int!
		title: String!
		body: String!
		url: URI!
		createdAt: DateTime!
		author: Actor
		category: DiscussionCategory!
		comments(first: Int, after: String): DiscussionCommentConnection!
	}

	type DiscussionComment implements Node {
		id: ID!
		databaseId: Int
		body: String!
		url: URI!
		createdAt: DateTime!
		author: Actor
	}

	type DiscussionCommentConnection {
		nodes: [DiscussionComment]
		totalCount: Int!
		pageInfo: PageInfo!
	}

	input AddDiscussionCommentInput {
		discussionId: ID!
		body: String!
		replyToId: ID
		clientMutationId: String
	}

	type AddDiscussionCommentPayload {
		clientMutationId: String
		comment: DiscussionComment
	}

	type Query {
		repository(owner: String!, name: String!): Repository
	}

	type Mutation {
		addDiscussionComment(input: AddDiscussionCommentInput!): AddDiscussionCommentPayload
	}
`;

const schema = buildSchema(SDL);

/** What a caller is: an installation (scoped by repo and permission) or a user. */
export interface GraphQLCaller {
	user: FakeUser;
	installation: InstallationRecord | null;
}

export interface GraphQLDeps {
	host: Host;
	bases: Bases;
	/** `owner/name` → the repo (and owner user), or null when unknown. */
	findRepo(owner: string, name: string): Promise<{ repo: { id: number; owner: string; name: string; fullName: string } } | null>;
	/** A repository by id, or null. */
	findRepoById(id: number): Promise<{ id: number; owner: string; name: string; fullName: string } | null>;
	userView(u: FakeUser): GitHubUser;
	/** Something happened that the event log should show. */
	onDiscussionComment(e: { repoId: number; owner: string; repo: string; number: number; commentId: number; author: string; body: string }): void;
}

type Raw = Record<string, unknown>;

const forbidden = () => new GraphQLError('Resource not accessible by integration', { extensions: { type: 'FORBIDDEN' } });
const notFound = (what: string) => new GraphQLError(what, { extensions: { type: 'NOT_FOUND' } });

/** `D_fake<repoId>_<number>` → its parts (see `discussionNodeId`). */
function parseDiscussionId(id: string): { repoId: number; number: number } | null {
	const m = /^D_fake(\d+)_(\d+)$/.exec(id);
	return m ? { repoId: Number(m[1]), number: Number(m[2]) } : null;
}

/** GraphQL `Int` is 32-bit (GitHub's `databaseId` too); the fake's ids are larger, so they are folded into range. */
const int32 = (id: unknown): number | null => (typeof id === 'number' ? id % 2_147_483_647 : null);

function actorView(u: { login: string; type?: string; node_id?: string }): Raw {
	return { __typename: u.type === 'Bot' ? 'Bot' : 'User', id: u.node_id ?? `U_${u.login}`, login: u.login };
}

/** A connection over a list, paged by index cursors (`first` capped at 100, like GitHub). */
function connection<T>(items: T[], args: { first?: number | null; after?: string | null }): { nodes: T[]; totalCount: number; pageInfo: Raw } {
	const start = args.after ? Number(Buffer.from(args.after, 'base64').toString('utf8')) + 1 : 0;
	const first = Math.min(Math.max(args.first ?? 100, 0), 100);
	const nodes = items.slice(start, start + first);
	const end = start + nodes.length - 1;
	return {
		nodes,
		totalCount: items.length,
		pageInfo: { hasNextPage: start + nodes.length < items.length, endCursor: nodes.length ? Buffer.from(String(end)).toString('base64') : null }
	};
}

export function createGraphQL(deps: GraphQLDeps) {
	const { host } = deps;

	function categoryNode(c: Raw): Raw {
		return { id: c.node_id, name: c.name, slug: c.slug, emoji: c.emoji, description: c.description, isAnswerable: c.is_answerable, createdAt: c.created_at };
	}

	function commentNode(c: Raw): Raw {
		return { id: c.node_id, databaseId: int32(c.id), body: c.body, url: c.html_url, createdAt: c.created_at, author: actorView(c.user as never) };
	}

	function discussionNode(repoId: number, view: Raw): Raw {
		const number = view.number as number;
		return {
			id: view.node_id,
			databaseId: int32(view.id),
			number,
			title: view.title,
			body: view.body,
			url: view.html_url,
			createdAt: view.created_at,
			author: actorView(view.user as never),
			category: categoryNode(view.category as Raw),
			comments: async (args: { first?: number; after?: string }) => {
				const r = await askActor<{ comments: Raw[] } | { error: string }>(host, repositoryAddress(repoId), REPOSITORY_EVENTS.getDiscussion, { number });
				if (isFailure(r)) throw notFound(`Could not resolve to a Discussion with the number of ${number}.`);
				return connection((r as { comments: Raw[] }).comments.map(commentNode), args);
			}
		};
	}

	/** Can `caller` use discussions of this repo (`write` for mutations)? */
	function allowed(caller: GraphQLCaller, repo: { fullName: string; owner: string }, level: 'read' | 'write'): boolean {
		const inst = caller.installation;
		if (!inst) return true;
		if (!repoCovered(inst, repo.fullName, repo.owner)) return false;
		const p = inst.permissions?.discussions;
		return level === 'read' ? p === 'read' || p === 'write' : p === 'write';
	}

	const root = {
		repository: async (args: { owner: string; name: string }, caller: GraphQLCaller) => {
			const found = await deps.findRepo(args.owner, args.name);
			if (!found) throw notFound(`Could not resolve to a Repository with the name '${args.owner}/${args.name}'.`);
			const repo = found.repo;
			if (caller.installation && !repoCovered(caller.installation, repo.fullName, repo.owner)) {
				throw notFound(`Could not resolve to a Repository with the name '${args.owner}/${args.name}'.`);
			}
			const address = repositoryAddress(repo.id);
			const info = async () => askActor<{ enabled: boolean; categories: Raw[] }>(host, address, REPOSITORY_EVENTS.discussionInfo, {});
			return {
				id: `R_fake${repo.id}`,
				databaseId: int32(repo.id),
				name: repo.name,
				nameWithOwner: repo.fullName,
				url: `${deps.bases.web}/${repo.fullName}`,
				hasDiscussionsEnabled: async () => (await info()).enabled,
				discussionCategories: async (a: { first?: number; after?: string }) => {
					if (!allowed(caller, repo, 'read')) throw forbidden();
					return connection((await info()).categories.map(categoryNode), a);
				},
				discussion: async (a: { number: number }) => {
					if (!allowed(caller, repo, 'read')) throw forbidden();
					const r = await askActor<{ discussion: Raw } | { error: string }>(host, address, REPOSITORY_EVENTS.getDiscussion, { number: a.number });
					if (isFailure(r)) throw notFound(`Could not resolve to a Discussion with the number of ${a.number}.`);
					return discussionNode(repo.id, (r as { discussion: Raw }).discussion);
				}
			};
		},

		addDiscussionComment: async (args: { input: { discussionId: string; body: string; clientMutationId?: string } }, caller: GraphQLCaller) => {
			const ref = parseDiscussionId(args.input.discussionId);
			const notResolved = () => notFound(`Could not resolve to a node with the global id of '${args.input.discussionId}'`);
			if (!ref) throw notResolved();
			const repos = await deps.findRepoById(ref.repoId);
			if (!repos) throw notResolved();
			if (!allowed(caller, repos, 'write')) throw forbidden();
			if (!args.input.body.trim()) throw new GraphQLError('Body cannot be blank', { extensions: { type: 'UNPROCESSABLE' } });
			const comment = await askActor<Raw | { error: string }>(host, repositoryAddress(ref.repoId), REPOSITORY_EVENTS.addDiscussionComment, {
				number: ref.number,
				id: nextId(),
				user: deps.userView(caller.user),
				body: args.input.body,
				now: new Date().toISOString()
			});
			if (isFailure(comment)) throw notResolved();
			const c = comment as Raw;
			deps.onDiscussionComment({ repoId: ref.repoId, owner: repos.owner, repo: repos.name, number: ref.number, commentId: c.id as number, author: caller.user.login, body: args.input.body });
			return { clientMutationId: args.input.clientMutationId ?? null, comment: commentNode(c) };
		}
	};

	/** Handle one GraphQL request body; the HTTP status is 200 even with errors, as on GitHub. */
	async function execute(body: unknown, caller: GraphQLCaller): Promise<{ status: number; body: unknown }> {
		const b = body as { query?: unknown; variables?: unknown; operationName?: unknown } | null;
		if (!b || typeof b.query !== 'string') return { status: 400, body: { message: 'Problems parsing JSON' } };
		const result = await graphql({
			schema,
			source: b.query,
			rootValue: root,
			contextValue: caller,
			variableValues: (b.variables as Record<string, unknown> | undefined) ?? undefined,
			// Root and nested resolvers are functions called as (args, caller, info) by graphql-js' default resolver.
			operationName: typeof b.operationName === 'string' ? b.operationName : undefined
		});
		return {
			status: 200,
			body: {
				...(result.data !== undefined ? { data: result.data } : {}),
				...(result.errors?.length
					? {
							errors: result.errors.map((e) => ({
								message: e.message,
								...(e.extensions?.type ? { type: e.extensions.type } : {}),
								...(e.path ? { path: e.path } : {}),
								...(e.locations ? { locations: e.locations } : {})
							}))
						}
					: {})
			}
		};
	}

	return { execute };
}

export type FakeGraphQL = ReturnType<typeof createGraphQL>;
