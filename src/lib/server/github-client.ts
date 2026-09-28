/**
 * The GitHub REST calls the outbox relay makes (ADR 0003, ADR 0006), via
 * `fetch` against `GITHUB_API_URL`. Responses are validated with the TypeBox
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

export interface GitHubClientOptions {
	apiUrl: string;
	token: string;
	/** Per-request timeout; default 15 s. */
	timeoutMs?: number;
	userAgent?: string;
}

const seg = encodeURIComponent;

export class GitHubClient {
	readonly #api: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #ua: string;

	constructor(opts: GitHubClientOptions) {
		this.#api = opts.apiUrl.replace(/\/+$/, '');
		this.#token = opts.token;
		this.#timeoutMs = opts.timeoutMs ?? 15_000;
		this.#ua = opts.userAgent ?? 'granary';
	}

	async #request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const res = await fetch(`${this.#api}${path}`, {
			method,
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${this.#token}`,
				'User-Agent': this.#ua,
				'X-GitHub-Api-Version': '2022-11-28',
				...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout
		});
		const text = await res.text();
		if (!res.ok) {
			throw new GitHubHttpError(method, path, res.status, text, parseRetryAfter(res.headers.get('retry-after')));
		}
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`${method} ${path}: response is not JSON`);
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
