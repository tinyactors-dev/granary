/**
 * Typed client for the fake GitHub `/__control` API (ADR 0035), plus a
 * small REST helper. Requests are built from and responses checked against
 * `fake-github/schemas.ts`.
 */
import type { TSchema, Static } from '@sinclair/typebox';
import {
	AcceptPermissionsResponse,
	CONTROL_PATHS,
	CreateIssueResponse,
	CreatePullRequestResponse,
	EnsureRepoResponse,
	EnsureUserResponse,
	InjectFaultResponse,
	InstallAppResponse,
	RedeliverResponse,
	ReopenIssueResponse,
	ResetResponse,
	parseFakeState,
	type CreateIssueRequest,
	type CreatePullRequestRequest,
	type SetAppPermissionsRequest,
	type EnsureRepoRequest,
	type EnsureUserRequest,
	type FakeIssue,
	type FakeState,
	type InjectFaultRequest,
	type InstallAppRequest,
	type ReopenIssueRequest
} from '../fake-github/schemas';
import { parse } from '../src/lib/schemas/standard';
import { Type } from '@sinclair/typebox';

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

	/** Keeps registered GitHub Apps by default, so granary stays connected (ADR 0230). */
	reset(opts: { keepApps?: boolean } = { keepApps: true }) {
		return this.call(ResetResponse, 'POST', CONTROL_PATHS.reset, opts);
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
	/** ADR 0282: opens a pull request and delivers `pull_request.opened` to apps that accepted the event. */
	createPullRequest(body: CreatePullRequestRequest) {
		return this.call(CreatePullRequestResponse, 'POST', CONTROL_PATHS.pulls, body);
	}
	/** ADR 0282: change what the app asks for; installations keep theirs until they accept. */
	setAppPermissions(appId: number, body: SetAppPermissionsRequest) {
		return this.call(Type.Object({ id: Type.Integer() }, { additionalProperties: true }), 'POST', CONTROL_PATHS.appPermissions(appId), body);
	}
	/** ADR 0282: the account accepts the app's current permissions (`installation.new_permissions_accepted`). */
	acceptPermissions(installationId: number) {
		return this.call(AcceptPermissionsResponse, 'POST', CONTROL_PATHS.acceptPermissions(installationId));
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
	/** ADR 0164: install a GitHub App without the UI (sends `installation` webhooks). */
	installApp(appId: number, body: InstallAppRequest) {
		return this.call(InstallAppResponse, 'POST', CONTROL_PATHS.appInstallations(appId), body);
	}
	/** ADR 0164: while down, deliveries fail with status_code 0. */
	webhookOutage(down: boolean) {
		return this.call(ResetResponse, 'POST', CONTROL_PATHS.webhookOutage, { down });
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
