/**
 * Typed client for the fake GitHub's `/__control` API (ADR 0006, 0035, 0075),
 * validating responses with TypeBox.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import {
	CONTROL_PATHS,
	CreateCommentControlResponse,
	CreateIssueResponse,
	EnsureRepoResponse,
	EventsLogResponse,
	FakeUser,
	InjectFaultResponse,
	RawDeliveryResponse,
	RedeliverResponse,
	ReopenIssueResponse,
	parseFakeState,
	type CreateCommentControlRequest,
	type CreateIssueRequest,
	type FakeState,
	type InjectFaultRequest,
	type RawDeliveryRequest,
	type ReopenIssueRequest
} from '../fake-github/schemas';
import { parse } from '../src/lib/schemas/standard';

export class FakeGithubError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'FakeGithubError';
	}
}

export class FakeClient {
	constructor(readonly base: string) {}

	async #call<S extends TSchema>(method: 'GET' | 'POST', path: string, schema: S, body?: unknown, timeoutMs = 30_000): Promise<Static<S>> {
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method,
				headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(timeoutMs)
			});
		} catch (e) {
			throw new FakeGithubError(0, `fake GitHub unreachable at ${this.base}: ${(e as Error).message}`);
		}
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* not JSON */
		}
		if (!res.ok) {
			const msg = (json as { error?: string } | null)?.error ?? text.slice(0, 200);
			throw new FakeGithubError(res.status, `${method} ${path} → ${res.status}: ${msg}`);
		}
		return parse(schema, json, `fake GitHub ${path}`);
	}

	ensureUser(login: string, type?: 'User' | 'Bot') {
		return this.#call('POST', CONTROL_PATHS.users, FakeUser, { login, ...(type ? { type } : {}) });
	}
	ensureRepo(owner: string, name: string) {
		return this.#call('POST', CONTROL_PATHS.repos, EnsureRepoResponse, { owner, name });
	}
	createIssue(req: CreateIssueRequest) {
		return this.#call('POST', CONTROL_PATHS.issues, CreateIssueResponse, req);
	}
	reopen(req: ReopenIssueRequest) {
		return this.#call('POST', CONTROL_PATHS.reopen, ReopenIssueResponse, req);
	}
	comment(req: CreateCommentControlRequest) {
		return this.#call('POST', CONTROL_PATHS.comment, CreateCommentControlResponse, req);
	}
	fault(req: InjectFaultRequest) {
		return this.#call('POST', CONTROL_PATHS.faults, InjectFaultResponse, req);
	}
	redeliver(deliveryId: string) {
		return this.#call('POST', CONTROL_PATHS.redeliver(deliveryId), RedeliverResponse);
	}
	raw(req: RawDeliveryRequest) {
		return this.#call('POST', CONTROL_PATHS.rawDelivery, RawDeliveryResponse, req);
	}
	eventsLog(since = 0, limit = 1) {
		return this.#call('GET', `${CONTROL_PATHS.eventsLog}?since=${since}&limit=${limit}`, EventsLogResponse);
	}
	async state(): Promise<FakeState> {
		const res = await fetch(`${this.base}${CONTROL_PATHS.state}`, { signal: AbortSignal.timeout(30_000) });
		if (!res.ok) throw new FakeGithubError(res.status, `GET state → ${res.status}`);
		return parseFakeState(await res.json());
	}
}
