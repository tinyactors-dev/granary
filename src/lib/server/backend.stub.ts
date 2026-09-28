/**
 * In-memory fake `Backend` for UI development (ADR 0032). NOT registered by
 * default. `hooks.server.ts` registers it instead of the real backend when
 * `GRANARY_STUB_BACKEND=1`:
 *
 * ```ts
 * if (config.stubBackend) setBackend(new StubBackend({ admins: config.admins, dapPort: config.dapPort }));
 * ```
 *
 * Run with e.g. `GRANARY_STUB_BACKEND=1 ADMINS=admin bun --bun vite dev`.
 * State is mutable (allowlist, sessions, effects, dev actions) and lives
 * until the process exits. No actor system, DB or network is touched.
 */
import { StubLoadgen } from './loadgen.stub';
import { StubFakeInfra } from './fake-infra.stub';
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
} from '$lib/schemas/api';
import { closeEffectKey, formatAddress, issueKey, parseIssueKey, type ActorAddress } from '$lib/schemas/actors';
import type { AuthorAssociation } from '$lib/schemas/github';
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
	TraceSummary
} from '$lib/schemas/dev';
import { StubTraces } from './trace-stub';
import { summarizeTraces } from './trace-summary';
import type { FakeState } from '../../../fake-github/schemas';
import type { InboxState, OutboxState, VerdictValue } from '$lib/schemas/wal';
import { SESSION_TTL_MS } from '$lib/schemas/wal';
import { BackendError, type Backend } from './backend';
import { chartFor } from './inspect/charts';
import { StubSettings } from './settings.stub';
import type { Admin, CreateLoginLinkInput } from '$lib/schemas/admins';
import type { BeginManifestInput, GitHubMode, SetRepoEnabledInput } from '$lib/schemas/github-app';

export interface StubBackendOptions {
	admins?: string[];
	dapPort?: number;
	fakeGithubUrl?: string;
	/** Public URL used in stub login links / manifest URLs (default http://localhost:5173). */
	origin?: string;
	/** GitHub connection mode to start in; `none` shows the setup wizard (ADR 0161). */
	githubMode?: GitHubMode;
}

interface StubIssue extends IssueSummary {
	deliveryId: string;
	receivedAt: number;
}

/** Strip stub-only fields so DTOs carry exactly `IssueSummary`. */
const summary = ({ deliveryId: _d, receivedAt: _r, ...rest }: StubIssue): IssueSummary => rest;

const MINUTE = 60_000;
const REPO_ID = 700001;

function page<T>(rows: T[], limit: number, before: string | undefined): Page<T> {
	const start = before ? Number(before) : 0;
	const items = rows.slice(start, start + limit);
	const next = start + limit;
	return { items, nextCursor: next < rows.length ? String(next) : null };
}

const hex = (n: number) =>
	Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

export class StubBackend implements Backend {
	private readonly admins: string[];
	private readonly dapPort: number;
	private readonly fakeGithubUrl: string;
	private readonly startedAt = Date.now() - 42 * MINUTE;
	private sessions = new Map<string, { login: string; avatarUrl: string | null; expiresAt: number }>();
	private allowed = new Map<string, AllowedUser>();
	private issues: StubIssue[] = [];
	private deliveries: DeliverySummary[] = [];
	private effects: EffectSummary[] = [];
	private verdicts: VerdictSummary[] = [];
	private fake: FakeState = { users: [], repos: [], issues: [], deliveries: [], faults: [] };
	private nextNumber = 1;
	private readonly settings: StubSettings;

	constructor(options: StubBackendOptions = {}) {
		this.admins = (options.admins ?? ['admin']).map((a) => a.toLowerCase());
		this.dapPort = options.dapPort ?? 4711;
		this.fakeGithubUrl = options.fakeGithubUrl ?? 'http://localhost:4010';
		this.settings = new StubSettings({
			admins: this.admins,
			origin: options.origin ?? 'http://localhost:5173',
			githubWebUrl: this.fakeGithubUrl,
			mode: options.githubMode
		});
		this.seed();
	}

	// -- seed data ---------------------------------------------------------------

	private seed() {
		const now = Date.now();
		for (const [login, by, ago] of [
			['alice', 'admin', 3000],
			['bob', 'admin', 2000],
			['dependabot[bot]', 'admin', 1000]
		] as const) {
			this.allowed.set(login, { login, addedBy: by, addedAt: now - ago * MINUTE });
		}
		for (const login of ['admin', 'alice', 'bob', 'mallory', 'eve']) this.ensureFakeUser(login);
		this.fake.repos.push({ id: REPO_ID, owner: 'acme', name: 'widgets', fullName: 'acme/widgets' });

		const seedIssue = (
			author: string,
			association: AuthorAssociation,
			title: string,
			minutesAgo: number,
			outcome: 'allowed' | 'closed' | 'failed' | 'pending' | 'closing'
		) => {
			const i = this.addIssue('acme', 'widgets', author, association, title, now - minutesAgo * MINUTE);
			const key = issueKey(i.repoId, i.number);
			const delivery = this.deliveries.find((d) => d.deliveryId === i.deliveryId)!;
			if (outcome === 'pending') return;
			if (outcome === 'closed' || outcome === 'failed' || outcome === 'closing') {
				const state: OutboxState = outcome === 'closed' ? 'done' : outcome === 'failed' ? 'dead' : 'pending';
				this.effects.unshift({
					effectKey: closeEffectKey(i.repoId, i.number),
					issueKey: key,
					state,
					attempts: outcome === 'failed' ? 6 : outcome === 'closing' ? 2 : 1,
					nextAttemptAt: outcome === 'closing' ? now + 30_000 : null,
					lastError: outcome === 'closed' ? null : 'PATCH /repos/acme/widgets/issues: 502 Bad Gateway',
					commentId: outcome === 'closed' ? 9000 + i.number : null,
					updatedAt: now - (minutesAgo - 1) * MINUTE,
					replyTo: { family: 'issue', name: key },
					payload: {
						repoId: i.repoId,
						owner: i.owner,
						repo: i.repo,
						number: i.number,
						author: i.author,
						association: i.association,
						title: i.title,
						htmlUrl: i.htmlUrl,
						deliveryId: i.deliveryId
					}
				});
				if (outcome === 'closing') return;
			}
			const verdict: VerdictValue = outcome;
			delivery.state = outcome === 'failed' ? 'failed' : 'done';
			this.verdicts.unshift({
				issueKey: key,
				verdict,
				reason:
					outcome === 'allowed'
						? association === 'NONE'
							? 'allowlist'
							: 'association'
						: outcome === 'closed'
							? 'not-allowed'
							: 'github-gave-up: PATCH /repos/acme/widgets/issues: 502 Bad Gateway',
				decidedAt: now - (minutesAgo - 1) * MINUTE,
				issue: summary(i)
			});
		};
		seedIssue('alice', 'NONE', 'Crash when saving widget', 180, 'allowed');
		seedIssue('mallory', 'NONE', 'Buy cheap watches', 150, 'closed');
		seedIssue('admin', 'OWNER', 'Release checklist 2.0', 120, 'allowed');
		seedIssue('eve', 'NONE', 'Please add dark mode', 60, 'failed');
		seedIssue('mallory', 'FIRST_TIME_CONTRIBUTOR', 'Spam again', 5, 'closing');
		seedIssue('bob', 'CONTRIBUTOR', 'Typo in README', 1, 'pending');
		this.deliveries.unshift({
			deliveryId: crypto.randomUUID(),
			event: 'ping',
			action: null,
			issueKey: null,
			state: 'ignored',
			receivedAt: now - 200 * MINUTE,
			issue: null
		});
		this.deliveries.sort((a, b) => b.receivedAt - a.receivedAt);
	}

	private ensureFakeUser(login: string) {
		if (!this.fake.users.some((u) => u.login.toLowerCase() === login.toLowerCase())) {
			const id = 1000 + this.fake.users.length;
			this.fake.users.push({ login, id, type: login.endsWith('[bot]') ? 'Bot' : 'User', avatarUrl: `https://avatars.example/${login}.png` });
		}
	}

	private addIssue(
		owner: string,
		repo: string,
		author: string,
		association: AuthorAssociation,
		title: string,
		at: number
	): StubIssue {
		const number = this.nextNumber++;
		const deliveryId = crypto.randomUUID();
		const htmlUrl = `${this.fakeGithubUrl}/${owner}/${repo}/issues/${number}`;
		const issue: StubIssue = { repoId: REPO_ID, owner, repo, number, title, author, association, htmlUrl, deliveryId, receivedAt: at };
		this.issues.push(issue);
		this.deliveries.unshift({
			deliveryId,
			event: 'issues',
			action: 'opened',
			issueKey: issueKey(REPO_ID, number),
			state: 'pending',
			receivedAt: at,
			issue: summary(issue)
		});
		this.ensureFakeUser(author);
		this.fake.issues.push({
			id: 50000 + number,
			number,
			title,
			body: '',
			state: 'open',
			state_reason: null,
			user: { login: author, id: 1, type: 'User' },
			author_association: association,
			html_url: htmlUrl,
			repoId: REPO_ID,
			owner,
			repo,
			comments: []
		});
		this.fake.deliveries.push({
			id: deliveryId,
			event: 'issues',
			action: 'opened',
			status: 'delivered',
			responseCode: 202,
			repoId: REPO_ID,
			issueNumber: number,
			attempts: 1,
			lastAttemptAt: at
		});
		return issue;
	}

	private user(login: string, avatarUrl: string | null): SessionUser {
		return { login, avatarUrl, isAdmin: this.admins.includes(login.toLowerCase()) || this.settings.isAdmin(login) };
	}

	// -- sessions ------------------------------------------------------------------

	async resolveSession(sessionId: string): Promise<SessionUser | null> {
		const s = this.sessions.get(sessionId);
		if (!s || s.expiresAt < Date.now()) return null;
		return this.user(s.login, s.avatarUrl);
	}

	async createSession(input: CreateSessionInput): Promise<CreatedSession> {
		const sessionId = hex(64);
		const expiresAt = Date.now() + SESSION_TTL_MS;
		const avatarUrl = input.avatarUrl ?? `https://avatars.example/${input.login}.png`;
		this.sessions.set(sessionId, { login: input.login, avatarUrl, expiresAt });
		return { sessionId, expiresAt, user: this.user(input.login, avatarUrl) };
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId);
	}

	// -- dashboard -------------------------------------------------------------------

	async getOverview(): Promise<Overview> {
		const inbox: Record<InboxState, number> = { pending: 0, done: 0, failed: 0, ignored: 0 };
		for (const d of this.deliveries) inbox[d.state]++;
		const outbox: Record<OutboxState, number> = { pending: 0, inflight: 0, done: 0, dead: 0 };
		for (const e of this.effects) outbox[e.state]++;
		const verdicts: Record<VerdictValue, number> = { allowed: 0, closed: 0, failed: 0 };
		for (const v of this.verdicts) verdicts[v.verdict]++;
		const actors = await this.listActors();
		const byFamily: Record<string, number> = {};
		for (const a of actors) byFamily[a.family] = (byFamily[a.family] ?? 0) + 1;
		const pendingDue = this.effects
			.filter((e) => e.state === 'pending' && e.nextAttemptAt !== null)
			.map((e) => e.nextAttemptAt!);
		return {
			inbox,
			outbox,
			verdicts,
			allowlistSize: this.allowed.size,
			system: {
				residentActors: actors.length,
				actorsByFamily: byFamily,
				queuedMessages: inbox.pending,
				deliveredMessages: 137,
				deadLetters: 2,
				memoryBytes: 3_481_600,
				startedAt: this.startedAt
			},
			nextRelayAttemptAt: pendingDue.length ? Math.min(...pendingDue) : null,
			generatedAt: Date.now()
		};
	}

	async listDeliveries(q: Resolved<ListDeliveriesInput>): Promise<Page<DeliverySummary>> {
		const rows = this.deliveries.filter((d) => !q.state || d.state === q.state);
		return page(rows, q.limit, q.before);
	}

	async listEffects(q: Resolved<ListEffectsInput>): Promise<Page<EffectSummary>> {
		const rows = [...this.effects]
			.filter((e) => !q.state || e.state === q.state)
			.sort((a, b) => b.updatedAt - a.updatedAt);
		return page(rows, q.limit, q.before);
	}

	async listVerdicts(q: Resolved<ListVerdictsInput>): Promise<Page<VerdictSummary>> {
		const rows = [...this.verdicts]
			.filter((v) => !q.verdict || v.verdict === q.verdict)
			.sort((a, b) => b.decidedAt - a.decidedAt);
		return page(rows, q.limit, q.before);
	}

	async getIssue(key: string): Promise<IssueDetail | null> {
		const { repoId, number } = parseIssueKey(key);
		const deliveries = this.deliveries.filter((d) => d.issueKey === key);
		const effect = this.effects.find((e) => e.issueKey === key) ?? null;
		const verdict = this.verdicts.find((v) => v.issueKey === key) ?? null;
		const actor = this.actorDetail(key);
		if (!deliveries.length && !effect && !verdict && !actor) return null;
		const found = this.issues.find((i) => issueKey(i.repoId, i.number) === key);
		const issue = found ? summary(found) : null;
		return { issueKey: key, repoId, number, issue, deliveries, effect, verdict, actor };
	}

	// -- allowlist -------------------------------------------------------------------

	async listAllowedUsers(): Promise<AllowedUser[]> {
		return [...this.allowed.values()].sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
	}

	async addAllowedUser(login: string, addedBy: string): Promise<AddAllowedUserResult> {
		const existing = [...this.allowed.values()].find((u) => u.login.toLowerCase() === login.toLowerCase());
		if (existing) return { user: existing, added: false };
		const user: AllowedUser = { login, addedBy, addedAt: Date.now() };
		this.allowed.set(login, user);
		return { user, added: true };
	}

	async removeAllowedUser(login: string): Promise<RemoveAllowedUserResult> {
		const existing = [...this.allowed.keys()].find((k) => k.toLowerCase() === login.toLowerCase());
		if (existing) this.allowed.delete(existing);
		return { login, removed: existing !== undefined };
	}

	// -- effects ---------------------------------------------------------------------

	async retryEffect(effectKey: string): Promise<EffectSummary> {
		const effect = this.effects.find((e) => e.effectKey === effectKey);
		if (!effect) throw new BackendError('not-found', `No effect ${effectKey}`);
		if (effect.state === 'done' || effect.state === 'inflight')
			throw new BackendError('conflict', `Effect ${effectKey} is ${effect.state}`);
		effect.state = 'pending';
		effect.attempts = 0;
		effect.nextAttemptAt = Date.now();
		effect.updatedAt = Date.now();
		return effect;
	}

	// -- actors ----------------------------------------------------------------------

	private actorSummary(address: ActorAddress, activeStates: string[], extra: Partial<ActorSummary> = {}): ActorSummary {
		return {
			address,
			id: formatAddress(address),
			family: address.family,
			revision: 'v1',
			sessionId: String(1000 + address.name.length * 7),
			activeStates,
			residency: 'idle',
			scheduling: 'idle',
			macrostepInProgress: false,
			macrostep: 3,
			microstep: 0,
			finalState: null,
			delayedSendCount: 0,
			mailboxDepth: 0,
			allocatedBytes: 2048,
			...extra
		};
	}

	private residentIssueKeys(): { key: string; states: string[]; delayed: number }[] {
		const out: { key: string; states: string[]; delayed: number }[] = [];
		for (const e of this.effects) if (e.state === 'pending' || e.state === 'inflight') out.push({ key: e.issueKey, states: ['closing'], delayed: 0 });
		for (const d of this.deliveries)
			if (d.state === 'pending' && d.issueKey && !out.some((o) => o.key === d.issueKey))
				out.push({ key: d.issueKey, states: ['checking'], delayed: 1 });
		return out;
	}

	async listActors(): Promise<ActorSummary[]> {
		const list = [
			this.actorSummary({ family: 'allowlist', name: 'main' }, ['ready'], { allocatedBytes: 4096 }),
			...this.residentIssueKeys().map((r) =>
				this.actorSummary({ family: 'issue', name: r.key }, r.states, { delayedSendCount: r.delayed })
			)
		];
		return list.sort((a, b) => a.id.localeCompare(b.id));
	}

	private actorDetail(key: string): ActorDetail | null {
		const r = this.residentIssueKeys().find((x) => x.key === key);
		if (!r) return null;
		const issue = this.issues.find((i) => issueKey(i.repoId, i.number) === key);
		return {
			...this.actorSummary({ family: 'issue', name: key }, r.states, { delayedSendCount: r.delayed }),
			data: {
				issueKey: key,
				phase: r.states[0] === 'closing' ? 'closing' : 'new',
				issue: issue ?? null,
				deliveryId: issue?.deliveryId ?? null,
				verdict: null,
				reason: null
			},
			delayedSends: r.delayed ? [{ id: 'check-timeout', event: 'check.timeout', due: Date.now() + 8000 }] : [],
			mailbox: [],
			currentEvent: null
		};
	}

	async inspectActor(address: ActorAddress): Promise<ActorSnapshot | null> {
		const id = formatAddress(address);
		const summary = (await this.listActors()).find((a) => a.id === id);
		if (!summary) return null;
		const now = Date.now();
		const isIssue = address.family === 'issue';
		const detail = isIssue ? this.actorDetail(address.name) : null;
		const checking = summary.activeStates.includes('checking');
		const closing = summary.activeStates.includes('closing');
		const data = isIssue
			? detail?.data ?? null
			: { logins: [...this.allowed.keys()].map((l) => l.toLowerCase()).sort() };
		return {
			...summary,
			capturedAt: now,
			runtime: { slot: isIssue ? 2 + (summary.sessionId.length % 5) : 1, generation: 1 },
			definition: {
				id: isIssue ? '2' : '3',
				family: address.family,
				revision: 'v1',
				name: address.family,
				datamodel: 'javascript',
				binding: 'early',
				stateCount: isIssue ? 8 : 1,
				actorCount: (await this.listActors()).filter((a) => a.family === address.family).length,
				retired: false
			},
			published: true,
			microstepInProgress: false,
			position: { at: 'none', state: null, transition: null, action: null, iteration: 0 },
			currentEvent: null,
			internalEvents: [],
			mailbox: closing
				? [{ event: 'issue.opened', data: { deliveryId: crypto.randomUUID(), note: 'duplicate delivery, ignored in closing' }, awaited: false, transition: null }]
				: [],
			mailboxTruncated: false,
			delayedSends: checking
				? [
						{
							id: 'check-timeout',
							event: 'check.timeout',
							due: now + 8000,
							ioType: 'http://www.w3.org/TR/scxml/#SCXMLEventProcessor',
							destination: 'self',
							target: null,
							data: null,
							submitted: false
						}
					]
				: [],
			invocations: [],
			data,
			completion: null,
			chart: chartFor({ family: address.family, revision: 'v1' }),
			issueKey: isIssue ? address.name : null
		};
	}

	// -- dev -------------------------------------------------------------------------

	async getDevTools(): Promise<DevTool[]> {
		return [
			{ id: 'ops', name: 'Ops', url: '/ops', description: 'Backups, telemetry and self-healing', group: 'granary', up: null, external: false },
			{ id: 'dap', name: `Debugger (DAP 127.0.0.1:${this.dapPort})`, url: '/__dev/actors', description: 'Attach configurations per actor', group: 'granary', up: null, external: false },
			{ id: 'fake-github', name: 'Fake GitHub', url: `${this.fakeGithubUrl}/`, description: 'Open issues as anyone, faults, deliveries', group: 'fakes', up: true, external: true },
			{ id: 'fake-infra', name: 'Fake infra', url: 'http://localhost:4090/', description: 'Fake R2, OTLP receiver, exe.dev proxy', group: 'fakes', up: false, external: true },
			{ id: 'loadgen', name: 'Load generator', url: '/__dev/load', description: 'Scenarios and personas (API http://localhost:4040)', group: 'fakes', up: true, external: false },
			{ id: 'sink:seed-otlp', name: 'Grafana (OTLP (seeded))', url: 'http://localhost:3300/explore', description: 'Logs (Loki), traces (Tempo), metrics (Prometheus)', group: 'ops targets', up: true, external: true, login: { username: 'admin', password: 'admin' } },
			{ id: 'dest:seed-s3', name: 'Storage console (S3-compatible (seed))', url: 'http://localhost:9001/rustfs/console/browser/?bucket=granary-backups&key=granary%2F', description: 'Backups of destination seed-s3', group: 'ops targets', up: true, external: true, login: { username: 'granary-dev', password: 'granary-dev-secret' } }
		];
	}

	async getDevInfo(): Promise<DevInfo> {
		return {
			dapHost: '127.0.0.1',
			dapPort: this.dapPort,
			fakeGithubUrl: this.fakeGithubUrl,
			admins: this.admins,
			fakeGithub: {
				reachable: true,
				error: null,
				state: this.fake,
				users: this.fake.users.map((u) => u.login)
			}
		};
	}

	async devOpenIssue(input: DevOpenIssueInput): Promise<DevOpenIssueResult> {
		if (!this.fake.repos.some((r) => r.owner === input.owner && r.name === input.repo)) {
			this.fake.repos.push({ id: REPO_ID, owner: input.owner, name: input.repo, fullName: `${input.owner}/${input.repo}` });
		}
		const i = this.addIssue(input.owner, input.repo, input.author, input.association ?? 'NONE', input.title, Date.now());
		return { number: i.number, deliveryId: i.deliveryId, repoId: i.repoId, issueKey: issueKey(i.repoId, i.number) };
	}

	async devReopenIssue(input: DevReopenIssueInput): Promise<DevReopenIssueResult> {
		const issue = this.fake.issues.find((i) => i.owner === input.owner && i.repo === input.repo && i.number === input.number);
		if (!issue) throw new BackendError('not-found', `No issue ${input.owner}/${input.repo}#${input.number}`);
		issue.state = 'open';
		issue.state_reason = 'reopened';
		const deliveryId = crypto.randomUUID();
		this.fake.deliveries.push({ id: deliveryId, event: 'issues', action: 'reopened', status: 'delivered', responseCode: 202 });
		this.deliveries.unshift({
			deliveryId,
			event: 'issues',
			action: 'reopened',
			issueKey: issueKey(issue.repoId, issue.number),
			state: 'ignored',
			receivedAt: Date.now(),
			issue: null
		});
		return { deliveryId };
	}

	async devRedeliver(deliveryId: string): Promise<DevRedeliverResult> {
		const d = this.fake.deliveries.find((x) => x.id === deliveryId);
		if (!d) throw new BackendError('not-found', `No delivery ${deliveryId}`);
		d.attempts = (d.attempts ?? 1) + 1;
		d.lastAttemptAt = Date.now();
		return { deliveryId, responseCode: 202 };
	}

	async devInjectFault(input: DevInjectFaultInput): Promise<DevInjectFaultResult> {
		const id = `fault-${this.fake.faults.length + 1}`;
		this.fake.faults.push({ id, method: input.method, pathPattern: input.pathPattern, status: input.status, remaining: input.count, ...(input.retryAfter !== undefined ? { retryAfter: input.retryAfter } : {}) });
		return { id };
	}

	async devReset(): Promise<void> {
		this.fake = { users: [], repos: [], issues: [], deliveries: [], faults: [] };
	}

	async devSendEvent(input: DevSendEvent): Promise<DevSendEventResult> {
		const actor = (await this.listActors()).find((a) => a.id === formatAddress(input.address));
		if (!actor) throw new BackendError('not-found', `No resident actor ${formatAddress(input.address)}`);
		return { status: 'stable', activeStates: actor.activeStates };
	}

	#traces?: StubTraces;

	async getRecentSpans(q: Resolved<GetRecentSpansInput>): Promise<SpanSummary[]> {
		this.#traces ??= new StubTraces();
		const out: SpanSummary[] = [];
		const all = this.#traces.all();
		for (let i = all.length - 1; i >= 0 && out.length < q.limit; i--) {
			const s = all[i]!;
			if (q.family && s.attributes['granary.actor.family'] !== q.family) continue;
			if (q.traceId && s.traceId !== q.traceId) continue;
			out.push(s);
		}
		return out;
	}

	async listRecentTraces(q: Resolved<ListRecentTracesInput>): Promise<TraceSummary[]> {
		this.#traces ??= new StubTraces();
		return summarizeTraces(this.#traces.all(), q);
	}

	async getDapLaunchConfig(address: ActorAddress): Promise<DapLaunchConfig> {
		const a = formatAddress(address);
		return { type: 'tinyactors', request: 'attach', name: `granary: ${a}`, port: this.dapPort, address: a };
	}

	// -- load generator (ADR 0076) ------------------------------------------------------

	#loadgen = new StubLoadgen();
	async getLoadgenStatus() {
		return this.#loadgen.info();
	}
	async listScenarios() {
		return this.#loadgen.listScenarios();
	}
	async getScenario(id: string) {
		return this.#loadgen.getScenario(id);
	}
	async createScenario(request: import('$lib/schemas/dev').CreateScenarioRequest) {
		return this.#loadgen.createScenario(request);
	}
	async controlScenario(id: string, action: import('$lib/schemas/dev').ScenarioAction) {
		return this.#loadgen.control(id, action);
	}
	async listPersonas(query: import('$lib/schemas/dev').ListPersonasQuery) {
		return this.#loadgen.listPersonas(query);
	}
	async getPersona(kind: import('$lib/schemas/dev').PersonaKind, name: string) {
		return this.#loadgen.getPersona(kind, name);
	}
	async listPersonaKinds() {
		return this.#loadgen.kinds();
	}
	async resetLoadgen() {
		this.#loadgen.reset();
	}

	// -- setup, admins, login links, GitHub connection (ADR 0160, 0161, 0166) ------
	async getSetupStatus() {
		return this.settings.getSetupStatus();
	}
	async listAdmins() {
		return this.settings.listAdmins();
	}
	async addAdmin(login: string, addedBy: string, source: Admin['source']) {
		return this.settings.addAdmin(login, addedBy, source);
	}
	async removeAdmin(login: string, removedBy: string) {
		return this.settings.removeAdmin(login, removedBy);
	}
	async createLoginLink(input: CreateLoginLinkInput, createdBy: string) {
		return this.settings.createLoginLink(input, createdBy);
	}
	async consumeLoginLink(token: string) {
		const login = this.settings.takeLoginLink(token);
		return login ? this.createSession({ login }) : null;
	}
	async listAuditLog(limit: number) {
		return this.settings.listAuditLog(limit);
	}
	async getGitHubStatus() {
		return this.settings.getGitHubStatus();
	}
	async beginGitHubAppManifest(input: BeginManifestInput, requestedBy: string) {
		return this.settings.beginGitHubAppManifest(input, requestedBy);
	}
	async completeGitHubAppManifest(code: string, state: string, actor: string) {
		return this.settings.completeGitHubAppManifest(code, state, actor);
	}
	async refreshGitHubInstallations(actor: string) {
		return this.settings.refreshGitHubInstallations(actor);
	}
	async setRepoEnabled(input: SetRepoEnabledInput, actor: string) {
		return this.settings.setRepoEnabled(input, actor);
	}

	// -- fake-infra (ADR 0139) ---------------------------------------------------
	#fakeInfra = new StubFakeInfra();
	async getFakeInfraStatus() {
		return this.#fakeInfra.info();
	}
	async fakeInfraControl(action: import('$lib/schemas/dev').FakeInfraAction) {
		return this.#fakeInfra.control(action);
	}
}
