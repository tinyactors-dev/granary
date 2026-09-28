/**
 * The real `Backend` (ADR 0032): read models from the SQLite WAL, live actor
 * inspection through the tinyactors system, allowlist mutations, effect
 * retries, sessions, and (dev only) the fake-GitHub control API, the span
 * ring buffer and DAP launch configurations.
 */
import { randomBytes } from 'node:crypto';
import { LoadgenClient } from './loadgen-client';
import { FakeInfraClient } from './fake-infra-client';
import { TinyactorsError, type ActorInspection } from '@tinyactors/node';
import type { TSchema, Static } from '@sinclair/typebox';
import type {
	ActorDetail,
	ActorSnapshot,
	ActorSummary,
	AddAllowedUserResult,
	AllowedUser,
	CreateSessionInput,
	CreatedSession,
	DeliverySummary,
	EffectSummary,
	IssueDetail,
	IssueSummary,
	ListDeliveriesInput,
	ListEffectsInput,
	ListVerdictsInput,
	Overview,
	Page,
	RemoveAllowedUserResult,
	Resolved,
	SessionUser,
	VerdictSummary
} from '../schemas/api';
import { formatAddress, parseIssueKey, type ActorAddress } from '../schemas/actors';
import { isAdminLogin } from '../schemas/config';
import type {
	DapLaunchConfig,
	DevInfo,
	DevTool,
	DevInjectFaultInput,
	DevInjectFaultResult,
	DevOpenIssueInput,
	DevOpenIssueResult,
	DevRedeliverResult,
	DevReopenIssueInput,
	DevReopenIssueResult,
	DevSendEvent,
	DevSendEventResult,
	GetRecentSpansInput,
	ListRecentTracesInput,
	SpanSummary,
	TraceSummary,
	CreateScenarioRequest as LoadgenCreateScenarioRequest,
	LoadgenInfo,
	FakeInfraAction,
	FakeInfraActionResult,
	FakeInfraInfo,
	ListPersonasQuery,
	PersonaDetail,
	PersonaKind,
	PersonaKindInfo,
	PersonaSummary,
	ScenarioAction,
	ScenarioDetail,
	ScenarioSummary
} from '../schemas/dev';
import { parseIssuesWebhook } from '../schemas/github';
import { issueKey } from '../schemas/actors';
import { parse, SchemaValidationError } from '../schemas/standard';
import {
	SESSION_TTL_MS,
	parseOutboxPayload,
	parseReplyTo,
	type InboxRow,
	type OutboxRow,
	type VerdictRow
} from '../schemas/wal';
import {
	CONTROL_PATHS,
	ControlOk,
	CreateIssueResponse,
	EnsureRepoResponse,
	InjectFaultResponse,
	RedeliverResponse,
	ReopenIssueResponse,
	parseFakeState
} from '../../../fake-github/schemas';
import { BackendError, type Backend } from './backend';
import type { AddAdminResult, Admin, AuditEntry, CreatedLoginLink, CreateLoginLinkInput, RemoveAdminResult, SetupStatus } from '../schemas/admins';
import type {
	BeginManifestInput,
	CompleteManifestResult,
	GitHubStatus,
	InstallationSummary,
	ManifestFormData,
	RepoSummary,
	SetRepoEnabledInput
} from '../schemas/github-app';
import { DAP_HOST } from './dap';
import type { Runtime } from './system';
import { addressOfInspection } from './tracing';
import { snapshotOf } from './inspect/snapshot';
import { destinationConsoleLink, getOpsBackend, hasOpsBackend } from '$lib/ops/contract';

function offsetPage<T>(rows: T[], limit: number, offset: number): Page<T> {
	// rows were fetched with limit + 1 to know whether there is a next page
	const items = rows.slice(0, limit);
	return { items, nextCursor: rows.length > limit ? String(offset + limit) : null };
}

function cursorOffset(before: string | undefined): number {
	if (!before) return 0;
	if (!/^\d{1,9}$/.test(before)) throw new BackendError('invalid', 'Invalid cursor');
	return Number(before);
}

/** JSON-safe deep copy (bigint → string, functions dropped). */
function jsonSafe(v: unknown): unknown {
	if (v === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
	} catch {
		return String(v);
	}
}

export class RealBackend implements Backend {
	readonly #rt: Runtime;

	constructor(runtime: Runtime) {
		this.#rt = runtime;
	}

	get #wal() {
		return this.#rt.wal;
	}

	#user(login: string, avatarUrl: string | null): SessionUser {
		return { login, avatarUrl, isAdmin: isAdminLogin(this.#rt.config, login) };
	}

	#requireDev(): void {
		if (!this.#rt.devMode) throw new BackendError('unavailable', 'Dev mode is off');
	}

	// -- sessions -----------------------------------------------------------------

	async resolveSession(sessionId: string): Promise<SessionUser | null> {
		if (!sessionId || sessionId.length < 16 || sessionId.length > 200) return null;
		const row = this.#wal.getSession(sessionId);
		return row ? this.#user(row.login, row.avatar_url) : null;
	}

	async createSession(input: CreateSessionInput): Promise<CreatedSession> {
		const now = Date.now();
		const id = randomBytes(32).toString('base64url');
		const expiresAt = now + SESSION_TTL_MS;
		const avatarUrl = input.avatarUrl ?? null;
		this.#wal.insertSession({ id, login: input.login, avatar_url: avatarUrl, created_at: now, expires_at: expiresAt });
		return { sessionId: id, expiresAt, user: this.#user(input.login, avatarUrl) };
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.#wal.deleteSession(sessionId);
	}

	// -- read models ----------------------------------------------------------------

	#issueSummary(row: InboxRow | null): IssueSummary | null {
		if (!row || row.event !== 'issues') return null;
		try {
			const p = parseIssuesWebhook(row.payload);
			return {
				repoId: p.repository.id,
				owner: p.repository.owner.login,
				repo: p.repository.name,
				number: p.issue.number,
				title: p.issue.title,
				author: p.issue.user.login,
				association: p.issue.author_association,
				htmlUrl: p.issue.html_url
			};
		} catch {
			return null;
		}
	}

	#delivery(row: InboxRow): DeliverySummary {
		return {
			deliveryId: row.delivery_id,
			event: row.event,
			action: row.action,
			issueKey: row.issue_key,
			state: row.state,
			receivedAt: row.received_at,
			issue: this.#issueSummary(row)
		};
	}

	#effect(row: OutboxRow): EffectSummary {
		return {
			effectKey: row.effect_key,
			issueKey: row.issue_key,
			state: row.state,
			attempts: row.attempts,
			nextAttemptAt: row.next_attempt_at,
			lastError: row.last_error,
			commentId: row.comment_id,
			updatedAt: row.updated_at,
			replyTo: parseReplyTo(row.reply_to),
			payload: parseOutboxPayload(row.payload)
		};
	}

	#verdict(row: VerdictRow): VerdictSummary {
		return {
			issueKey: row.issue_key,
			verdict: row.verdict,
			reason: row.reason,
			decidedAt: row.decided_at,
			issue: this.#issueSummary(this.#wal.latestIssuesInbox(row.issue_key))
		};
	}

	async getOverview(): Promise<Overview> {
		const actors = this.#inspections();
		const byFamily: Record<string, number> = {};
		for (const a of actors) byFamily[a.definition.family] = (byFamily[a.definition.family] ?? 0) + 1;
		const stats = this.#rt.system.stats();
		return {
			inbox: this.#wal.inboxCounts(),
			outbox: this.#wal.outboxCounts(),
			verdicts: this.#wal.verdictCounts(),
			allowlistSize: this.#wal.allowedCount(),
			system: {
				residentActors: actors.length,
				actorsByFamily: byFamily,
				queuedMessages: stats.messages.queued,
				deliveredMessages: stats.messages.delivered,
				deadLetters: stats.messages.deadLetters,
				memoryBytes: stats.memory.total.bytesInUse,
				startedAt: this.#rt.startedAt
			},
			nextRelayAttemptAt: this.#wal.nextOutboxDueAt(),
			generatedAt: Date.now()
		};
	}

	async listDeliveries(q: Resolved<ListDeliveriesInput>): Promise<Page<DeliverySummary>> {
		const offset = cursorOffset(q.before);
		const rows = this.#wal.listInbox(q.state, q.limit + 1, offset);
		return offsetPage(rows.map((r) => this.#delivery(r)), q.limit, offset);
	}

	async listEffects(q: Resolved<ListEffectsInput>): Promise<Page<EffectSummary>> {
		const offset = cursorOffset(q.before);
		const rows = this.#wal.listOutbox(q.state, q.limit + 1, offset);
		return offsetPage(rows.map((r) => this.#effect(r)), q.limit, offset);
	}

	async listVerdicts(q: Resolved<ListVerdictsInput>): Promise<Page<VerdictSummary>> {
		const offset = cursorOffset(q.before);
		const rows = this.#wal.listVerdicts(q.verdict, q.limit + 1, offset);
		return offsetPage(rows.map((r) => this.#verdict(r)), q.limit, offset);
	}

	async getIssue(key: string): Promise<IssueDetail | null> {
		const { repoId, number } = parseIssueKey(key);
		const inbox = this.#wal.inboxForIssue(key);
		const outbox = this.#wal.outboxForIssue(key);
		const verdict = this.#wal.getVerdict(key);
		const actor = this.#rt.system.findActor({ family: 'issue', name: key });
		const detail = actor && !actor.destroyed ? this.#actorDetail(actor.inspect()) : null;
		if (!inbox.length && !outbox && !verdict && !detail) return null;
		return {
			issueKey: key,
			repoId,
			number,
			issue: this.#issueSummary(this.#wal.latestIssuesInbox(key)),
			deliveries: inbox.map((r) => this.#delivery(r)),
			effect: outbox ? this.#effect(outbox) : null,
			verdict: verdict ? this.#verdict(verdict) : null,
			actor: detail
		};
	}

	// -- allowlist --------------------------------------------------------------------

	async listAllowedUsers(): Promise<AllowedUser[]> {
		return this.#wal.listAllowedUsers().map((r) => ({ login: r.login, addedBy: r.added_by, addedAt: r.added_at }));
	}

	async addAllowedUser(login: string, addedBy: string): Promise<AddAllowedUserResult> {
		const { row, added } = this.#wal.addAllowedUser(login, addedBy);
		if (added) this.#rt.publishAllowlist();
		return { user: { login: row.login, addedBy: row.added_by, addedAt: row.added_at }, added };
	}

	async removeAllowedUser(login: string, _removedBy: string): Promise<RemoveAllowedUserResult> {
		const removed = this.#wal.removeAllowedUser(login);
		if (removed) this.#rt.publishAllowlist();
		return { login, removed };
	}

	// -- effects ------------------------------------------------------------------------

	async retryEffect(effectKey: string, _requestedBy: string): Promise<EffectSummary> {
		const row = this.#wal.getOutbox(effectKey);
		if (!row) throw new BackendError('not-found', `No effect ${effectKey}`);
		if (row.state === 'done' || row.state === 'inflight')
			throw new BackendError('conflict', `Effect ${effectKey} is ${row.state}`);
		const updated = this.#wal.retryOutbox(effectKey);
		this.#rt.relay.kick();
		return this.#effect(updated);
	}

	// -- actors ---------------------------------------------------------------------------

	#inspections(): ActorInspection[] {
		return [...this.#rt.system.actors()];
	}

	#actorSummary(i: ActorInspection): ActorSummary {
		const address = addressOfInspection(i);
		const revision = typeof i.definition.revision === 'string' ? i.definition.revision : Buffer.from(i.definition.revision).toString('hex');
		let mailboxDepth = 0;
		try {
			mailboxDepth = this.#rt.system.mailbox(i.actor, { limit: 1000 }).length;
		} catch {
			/* gone */
		}
		return {
			address,
			id: address ? formatAddress(address) : `#${i.sessionID}`,
			family: i.definition.family,
			revision,
			sessionId: String(i.sessionID),
			activeStates: [...i.activeStates],
			residency: i.residency,
			scheduling: i.scheduling,
			macrostepInProgress: i.macrostepInProgress,
			macrostep: i.step.macrostep,
			microstep: i.step.microstep,
			finalState: i.finalState,
			delayedSendCount: i.delayedSendCount,
			mailboxDepth,
			allocatedBytes: i.allocatedBytes
		};
	}

	#actorDetail(i: ActorInspection): ActorDetail {
		const system = this.#rt.system;
		const offset = Date.now() - system.time;
		let mailbox: ActorDetail['mailbox'] = [];
		try {
			mailbox = system.mailbox(i.actor, { limit: 50 }).map((m) => ({ event: m.event, data: jsonSafe(m.data) }));
		} catch {
			/* gone */
		}
		return {
			...this.#actorSummary(i),
			data: jsonSafe(i.data),
			delayedSends: i.delayedSends.map((d) => ({ id: d.id, event: d.event, due: Math.round(d.due + offset) })),
			mailbox,
			currentEvent: i.currentEvent?.name ?? null
		};
	}

	async listActors(): Promise<ActorSummary[]> {
		return this.#inspections()
			.map((i) => this.#actorSummary(i))
			.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
	}

	async inspectActor(address: ActorAddress): Promise<ActorSnapshot | null> {
		const system = this.#rt.system;
		const actor = system.findActor(address);
		if (!actor) return null;
		try {
			const i = actor.inspect();
			// the directory knows the address even when data has no issueKey yet
			const summary = { ...this.#actorSummary(i), address, id: formatAddress(address) };
			return snapshotOf(system, i, summary);
		} catch (e) {
			if (e instanceof TinyactorsError && (e.code === 'not-found' || e.code === 'closed')) return null;
			throw e;
		}
	}

	// -- dev ------------------------------------------------------------------------------

	async #control<S extends TSchema>(method: 'GET' | 'POST', path: string, schema: S, body?: unknown): Promise<Static<S>> {
		this.#requireDev();
		const url = `${this.#rt.config.fakeGithubUrl}${path}`;
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(10_000)
			});
		} catch (e) {
			throw new BackendError('upstream', `Fake GitHub unreachable at ${this.#rt.config.fakeGithubUrl}: ${(e as Error).message}`);
		}
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* not JSON */
		}
		if (!res.ok) {
			const message =
				(json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
					? (json as { error: string }).error
					: text.slice(0, 200)) || `HTTP ${res.status}`;
			if (res.status === 404) throw new BackendError('not-found', message);
			if (res.status === 400) throw new BackendError('invalid', message);
			throw new BackendError('upstream', `${method} ${path} → ${res.status}: ${message}`);
		}
		try {
			return parse(schema, json, `fake GitHub ${path} response`);
		} catch (e) {
			if (e instanceof SchemaValidationError) throw new BackendError('upstream', e.message);
			throw e;
		}
	}

	async getDevTools(): Promise<DevTool[]> {
		this.#requireDev();
		const c = this.#rt.config;
		const tools: DevTool[] = [
			{ id: 'ops', name: 'Ops', url: '/ops', description: 'Backups, telemetry and self-healing', group: 'granary', up: null, external: false },
			{ id: 'dap', name: `Debugger (DAP ${DAP_HOST}:${c.dapPort})`, url: '/__dev/actors', description: 'Attach configurations per actor', group: 'granary', up: null, external: false },
			{ id: 'fake-github', name: 'Fake GitHub', url: `${c.fakeGithubUrl}/`, description: 'Open issues as anyone, faults, deliveries', group: 'fakes', up: null, external: true },
			{ id: 'fake-infra', name: 'Fake infra', url: `${c.fakeInfraUrl}/`, description: 'Fake R2, OTLP receiver, exe.dev proxy', group: 'fakes', up: null, external: true },
			{ id: 'loadgen', name: 'Load generator', url: '/__dev/load', description: `Scenarios and personas (API ${c.loadgenUrl})`, group: 'fakes', up: null, external: false }
		];
		const probes: Record<string, string> = { 'fake-github': `${c.fakeGithubUrl}/`, 'fake-infra': `${c.fakeInfraUrl}/`, loadgen: `${c.loadgenUrl}/api/status` };
		if (hasOpsBackend()) {
			const ops = getOpsBackend();
			const [sinks, dests] = await Promise.all([ops.listSinks().catch(() => []), ops.listDestinations().catch(() => [])]);
			for (const s of sinks) {
				if (!s.grafanaUrl) continue;
				tools.push({ id: `sink:${s.id}`, name: `Grafana (${s.name})`, url: s.grafanaUrl, description: 'Logs (Loki), traces (Tempo), metrics (Prometheus)', group: 'ops targets', up: null, external: true });
				probes[`sink:${s.id}`] = s.grafanaUrl;
			}
			for (const d of dests) {
				const link = destinationConsoleLink(d);
				if (!link) continue;
				tools.push({ id: `dest:${d.id}`, name: `Storage console (${d.name})`, url: link.url, description: `Backups of destination ${d.id}`, group: 'ops targets', up: null, external: true });
				probes[`dest:${d.id}`] = link.url;
			}
		}
		for (const t of tools) {
			if (!t.external) continue;
			try {
				const hint = c.devLoginHints[new URL(t.url).origin];
				if (hint) t.login = hint;
			} catch {
				/* relative or odd URL: no hint */
			}
		}
		// Reachability: any HTTP answer below 500 counts as up (logins redirect, SPAs 200).
		await Promise.all(
			tools.map(async (t) => {
				const url = probes[t.id];
				if (!url) return;
				try {
					const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(1500) });
					t.up = res.status < 500;
					await res.body?.cancel();
				} catch {
					t.up = false;
				}
			})
		);
		return tools;
	}

	async getDevInfo(): Promise<DevInfo> {
		this.#requireDev();
		const base = {
			dapHost: DAP_HOST,
			dapPort: this.#rt.config.dapPort,
			fakeGithubUrl: this.#rt.config.fakeGithubUrl,
			admins: this.#rt.config.admins
		};
		try {
			const res = await fetch(`${this.#rt.config.fakeGithubUrl}${CONTROL_PATHS.state}`, {
				signal: AbortSignal.timeout(5000)
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const state = parseFakeState(await res.json());
			return { ...base, fakeGithub: { reachable: true, error: null, state, users: state.users.map((u) => u.login) } };
		} catch (e) {
			return {
				...base,
				fakeGithub: { reachable: false, error: (e as Error).message, state: null, users: [] }
			};
		}
	}

	async devOpenIssue(input: DevOpenIssueInput): Promise<DevOpenIssueResult> {
		const repo = await this.#control('POST', CONTROL_PATHS.repos, EnsureRepoResponse, {
			owner: input.owner,
			name: input.repo
		});
		const created = await this.#control('POST', CONTROL_PATHS.issues, CreateIssueResponse, input);
		return {
			number: created.number,
			deliveryId: created.deliveryId,
			repoId: repo.id,
			issueKey: issueKey(repo.id, created.number)
		};
	}

	async devReopenIssue(input: DevReopenIssueInput): Promise<DevReopenIssueResult> {
		return this.#control('POST', CONTROL_PATHS.reopen, ReopenIssueResponse, input);
	}

	async devRedeliver(deliveryId: string): Promise<DevRedeliverResult> {
		return this.#control('POST', CONTROL_PATHS.redeliver(deliveryId), RedeliverResponse);
	}

	async devInjectFault(input: DevInjectFaultInput): Promise<DevInjectFaultResult> {
		return this.#control('POST', CONTROL_PATHS.faults, InjectFaultResponse, input);
	}

	async devReset(): Promise<void> {
		await this.#control('POST', CONTROL_PATHS.reset, ControlOk);
	}

	async devSendEvent(input: DevSendEvent): Promise<DevSendEventResult> {
		this.#requireDev();
		const system = this.#rt.system;
		try {
			const result = await system.send(input.address, input.event, input.data, { until: 'completed', timeout: 5000 });
			const actor = system.findActor(input.address);
			let activeStates: string[] | null = null;
			if (actor && !actor.destroyed) {
				try {
					activeStates = [...actor.inspect().activeStates];
				} catch {
					activeStates = null;
				}
			}
			return { status: result.status, activeStates };
		} catch (e) {
			if (e instanceof TinyactorsError) {
				if (e.code === 'not-found') throw new BackendError('not-found', `No actor at ${formatAddress(input.address)}`);
				throw new BackendError('invalid', e.code);
			}
			throw e;
		}
	}

	async getRecentSpans(q: Resolved<GetRecentSpansInput>): Promise<SpanSummary[]> {
		this.#requireDev();
		return this.#rt.tracer.recent(q);
	}

	async listRecentTraces(q: Resolved<ListRecentTracesInput>): Promise<TraceSummary[]> {
		this.#requireDev();
		return this.#rt.tracer.traces(q);
	}

	async getDapLaunchConfig(address: ActorAddress): Promise<DapLaunchConfig> {
		this.#requireDev();
		const a = formatAddress(address);
		return { type: 'tinyactors', request: 'attach', name: `granary: ${a}`, port: this.#rt.config.dapPort, address: a };
	}

	// -- load generator (ADR 0076) ------------------------------------------------------

	#loadgenClient: LoadgenClient | null = null;
	get #loadgen(): LoadgenClient {
		this.#requireDev();
		return (this.#loadgenClient ??= new LoadgenClient(this.#rt.config.loadgenUrl));
	}

	getLoadgenStatus(): Promise<LoadgenInfo> {
		return this.#loadgen.info();
	}
	listScenarios(): Promise<ScenarioSummary[]> {
		return this.#loadgen.listScenarios();
	}
	getScenario(id: string): Promise<ScenarioDetail> {
		return this.#loadgen.getScenario(id);
	}
	createScenario(request: LoadgenCreateScenarioRequest): Promise<ScenarioSummary> {
		return this.#loadgen.createScenario(request);
	}
	controlScenario(id: string, action: ScenarioAction): Promise<ScenarioSummary> {
		return this.#loadgen.control(id, action);
	}
	listPersonas(query: ListPersonasQuery): Promise<PersonaSummary[]> {
		return this.#loadgen.listPersonas(query);
	}
	getPersona(kind: PersonaKind, name: string): Promise<PersonaDetail> {
		return this.#loadgen.getPersona(kind, name);
	}
	listPersonaKinds(): Promise<PersonaKindInfo[]> {
		return this.#loadgen.kinds();
	}
	resetLoadgen(): Promise<void> {
		return this.#loadgen.reset();
	}

	// -- setup, admins, login links (ADR 0161): pinned by ADR 0166, implemented by fork E1 --

	#pending(fork: string): never {
		throw new BackendError('unavailable', `not implemented yet (ADR 0166, fork ${fork})`);
	}
	async getSetupStatus(): Promise<SetupStatus> {
		return this.#pending('E1');
	}
	async listAdmins(): Promise<Admin[]> {
		return this.#pending('E1');
	}
	async addAdmin(_login: string, _addedBy: string, _source: Admin['source']): Promise<AddAdminResult> {
		return this.#pending('E1');
	}
	async removeAdmin(_login: string, _removedBy: string): Promise<RemoveAdminResult> {
		return this.#pending('E1');
	}
	async createLoginLink(_input: CreateLoginLinkInput, _createdBy: string): Promise<CreatedLoginLink> {
		return this.#pending('E1');
	}
	async consumeLoginLink(_token: string): Promise<CreatedSession | null> {
		return this.#pending('E1');
	}
	async listAuditLog(_limit: number): Promise<AuditEntry[]> {
		return this.#pending('E1');
	}

	// -- GitHub connection (ADR 0160, 0162): implemented by fork E3 ---------------------

	async getGitHubStatus(): Promise<GitHubStatus> {
		return this.#pending('E3');
	}
	async beginGitHubAppManifest(_input: BeginManifestInput, _requestedBy: string): Promise<ManifestFormData> {
		return this.#pending('E3');
	}
	async completeGitHubAppManifest(_code: string, _state: string, _actor: string): Promise<CompleteManifestResult> {
		return this.#pending('E3');
	}
	async refreshGitHubInstallations(_actor: string): Promise<InstallationSummary[]> {
		return this.#pending('E3');
	}
	async setRepoEnabled(_input: SetRepoEnabledInput, _actor: string): Promise<RepoSummary> {
		return this.#pending('E3');
	}

	// -- fake-infra (ADR 0139) ---------------------------------------------------

	#fakeInfraClient: FakeInfraClient | null = null;
	get #fakeInfra(): FakeInfraClient {
		this.#requireDev();
		return (this.#fakeInfraClient ??= new FakeInfraClient(this.#rt.config.fakeInfraUrl));
	}
	getFakeInfraStatus(): Promise<FakeInfraInfo> {
		return this.#fakeInfra.info();
	}
	fakeInfraControl(action: FakeInfraAction): Promise<FakeInfraActionResult> {
		return this.#fakeInfra.control(action);
	}
}
