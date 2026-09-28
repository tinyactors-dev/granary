/**
 * Typed client for the fake GitHub `/__control` API (ADR 0035), plus a
 * small REST helper. Requests are built from and responses checked against
 * `fake-github/schemas.ts`.
 */
import type { TSchema, Static } from '@sinclair/typebox';
import {
	CONTROL_PATHS,
	CreateIssueResponse,
	EnsureRepoResponse,
	EnsureUserResponse,
	InjectFaultResponse,
	RedeliverResponse,
	ReopenIssueResponse,
	ResetResponse,
	parseFakeState,
	type CreateIssueRequest,
	type EnsureRepoRequest,
	type EnsureUserRequest,
	type FakeIssue,
	type FakeState,
	type InjectFaultRequest,
	type ReopenIssueRequest
} from '../fake-github/schemas';
import { parse } from '../src/lib/schemas/standard';

export class FakeGithubError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		what: string
	) {
		super(`fake GitHub ${what} → ${status}: ${body}`);
	}
}

export class FakeGithubClient {
	constructor(readonly baseUrl: string) {}

	private async call<T extends TSchema>(schema: T, method: string, path: string, body?: unknown): Promise<Static<T>> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const text = await res.text();
		if (!res.ok) throw new FakeGithubError(res.status, text, `${method} ${path}`);
		return parse(schema, JSON.parse(text), `${method} ${path} response`);
	}

	reset() {
		return this.call(ResetResponse, 'POST', CONTROL_PATHS.reset);
	}
	ensureUser(body: EnsureUserRequest) {
		return this.call(EnsureUserResponse, 'POST', CONTROL_PATHS.users, body);
	}
	ensureRepo(body: EnsureRepoRequest) {
		return this.call(EnsureRepoResponse, 'POST', CONTROL_PATHS.repos, body);
	}
	/** Creates the issue and delivers `issues.opened`; resolves after the delivery attempt. */
	createIssue(body: CreateIssueRequest) {
		return this.call(CreateIssueResponse, 'POST', CONTROL_PATHS.issues, body);
	}
	reopen(body: ReopenIssueRequest) {
		return this.call(ReopenIssueResponse, 'POST', CONTROL_PATHS.reopen, body);
	}
	redeliver(deliveryId: string) {
		return this.call(RedeliverResponse, 'POST', CONTROL_PATHS.redeliver(deliveryId));
	}
	injectFault(body: InjectFaultRequest) {
		return this.call(InjectFaultResponse, 'POST', CONTROL_PATHS.faults, body);
	}
	async state(): Promise<FakeState> {
		const res = await fetch(`${this.baseUrl}${CONTROL_PATHS.state}`);
		if (!res.ok) throw new FakeGithubError(res.status, await res.text(), 'GET state');
		return parseFakeState(await res.json());
	}
	async issue(owner: string, repo: string, number: number): Promise<FakeIssue | undefined> {
		const s = await this.state();
		return s.issues.find((i) => i.owner === owner && i.repo === repo && i.number === number);
	}
	/** A delivery's current record. */
	async delivery(id: string) {
		return (await this.state()).deliveries.find((d) => d.id === id);
	}
}
