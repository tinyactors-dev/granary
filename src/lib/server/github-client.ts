/**
 * The GitHub REST calls the outbox relay makes (ADR 0003, ADR 0006), via
 * `fetch` against `GRANARY_GITHUB_API_URL`. Responses are validated with the TypeBox
 * schemas of `$lib/schemas/github`; request bodies are validated before
 * sending.
 */
import {
	CreateCommentRequest,
	UpdateIssueRequest,
	parseIssue,
	parseIssueComment,
	parseIssueCommentList,
	type Issue,
	type IssueComment
} from '../schemas/github';
import { parse } from '../schemas/standard';

export class GitHubHttpError extends Error {
	readonly status: number;
	/** Milliseconds to wait, from `Retry-After` (seconds or HTTP date), or null. */
	readonly retryAfterMs: number | null;
	constructor(method: string, path: string, status: number, body: string, retryAfterMs: number | null) {
		super(`${method} ${path} → ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
		this.name = 'GitHubHttpError';
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const at = Date.parse(trimmed);
	return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** A bearer token, or a provider called per request (installation tokens, ADR 0191). */
export type TokenSource = string | (() => Promise<string>);

export interface GitHubRequestOptions {
	apiUrl: string;
	/** Sent as `Authorization: Bearer …`. */
	token: string;
	/** Per-request timeout; default 15 s. */
	timeoutMs?: number;
	userAgent?: string;
	signal?: AbortSignal;
	/** Sees the response headers of a successful call (e.g. `Link` for cursor paging). */
	onHeaders?: (headers: Headers) => void;
}

/**
 * One GitHub REST call: JSON in, parsed JSON (or null) out; non-2xx throws
 * GitHubHttpError with `Retry-After`. Shared by the issue client and the
 * app-level calls (JWT / installation tokens).
 */
export async function githubRequest(opts: GitHubRequestOptions, method: string, path: string, body?: unknown): Promise<unknown> {
	const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
	const res = await fetch(`${opts.apiUrl.replace(/\/+$/, '')}${path}`, {
		method,
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${opts.token}`,
			'User-Agent': opts.userAgent ?? 'granary',
			'X-GitHub-Api-Version': '2022-11-28',
			...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
	});
	const text = await res.text();
	if (!res.ok) {
		throw new GitHubHttpError(method, path, res.status, text, parseRetryAfter(res.headers.get('retry-after')));
	}
	opts.onHeaders?.(res.headers);
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${method} ${path}: response is not JSON`);
	}
}

/** The `rel="next"` URL of a `Link` header, or null. */
export function nextLink(link: string | null): string | null {
	if (!link) return null;
	for (const part of link.split(',')) {
		const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
		if (m) return m[1]!;
	}
	return null;
}

export interface GitHubClientOptions {
	apiUrl: string;
	/** An installation-token provider, or a fixed token (e.g. an app JWT). */
	token: TokenSource;
	/** Per-request timeout; default 15 s. */
	timeoutMs?: number;
	userAgent?: string;
	/** Called when GitHub answers 401, e.g. to drop a cached installation token. */
	onUnauthorized?: () => void;
}

const seg = encodeURIComponent;

export class GitHubClient {
	readonly #api: string;
	readonly #token: TokenSource;
	readonly #timeoutMs: number;
	readonly #ua: string;
	readonly #onUnauthorized: (() => void) | undefined;

	constructor(opts: GitHubClientOptions) {
		this.#api = opts.apiUrl.replace(/\/+$/, '');
		this.#token = opts.token;
		this.#timeoutMs = opts.timeoutMs ?? 15_000;
		this.#ua = opts.userAgent ?? 'granary';
		this.#onUnauthorized = opts.onUnauthorized;
	}

	async #request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		const token = typeof this.#token === 'string' ? this.#token : await this.#token();
		try {
			return await githubRequest({ apiUrl: this.#api, token, timeoutMs: this.#timeoutMs, userAgent: this.#ua, signal }, method, path, body);
		} catch (e) {
			if (e instanceof GitHubHttpError && e.status === 401) this.#onUnauthorized?.();
			throw e;
		}
	}

	#issuePath(owner: string, repo: string, number: number): string {
		return `/repos/${seg(owner)}/${seg(repo)}/issues/${number}`;
	}

	async createComment(owner: string, repo: string, number: number, body: string, signal?: AbortSignal): Promise<IssueComment> {
		const req = parse(CreateCommentRequest, { body }, 'comment request');
		return parseIssueComment(await this.#request('POST', `${this.#issuePath(owner, repo, number)}/comments`, req, signal));
	}

	/** All comments of an issue (follows `page` until a short page, max 10 pages of 100). */
	async listComments(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<IssueComment[]> {
		const out: IssueComment[] = [];
		for (let page = 1; page <= 10; page++) {
			const list = parseIssueCommentList(
				await this.#request('GET', `${this.#issuePath(owner, repo, number)}/comments?per_page=100&page=${page}`, undefined, signal)
			);
			out.push(...list);
			if (list.length < 100) break;
		}
		return out;
	}

	async closeIssue(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<Issue> {
		const req = parse(UpdateIssueRequest, { state: 'closed', state_reason: 'not_planned' }, 'update issue request');
		return parseIssue(await this.#request('PATCH', this.#issuePath(owner, repo, number), req, signal));
	}
}
