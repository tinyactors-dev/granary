/**
 * The real `Backend` (ADR 0032): read models from the SQLite WAL, live actor
 * inspection through the tinyactors host, allowlist mutations, effect
 * retries, sessions, and (dev only) the fake-GitHub control API and the span
 * ring buffer.
 */
import type { ClosingMessages } from '$lib/schemas/message-template';
import { readClosingMessages, saveClosingMessages } from './closing-messages';
import { CLOSING_MESSAGES_SETTING } from '$lib/schemas/message-template';
import { randomBytes } from 'node:crypto';
import { LoadgenClient } from './loadgen-client';
import { FakeInfraClient } from './fake-infra-client';
import { StaleError, type Actor } from '@tinyactors/node';
import type { TSchema, Static } from '@sinclair/typebox';
import type {
	ActorDetail,
	ActorSnapshot,
	ActorSummary,
	AddAllowedUserResult,
	AdmitAuthorResult,
	AdmitScope,
	AllowedUser,
	BlockedUser,
	BlockUserRequest,
	BlockUserResult,
	CreateSessionInput,
	CreatedSession,
	DeliverySummary,
	EffectSummary,
	IssueDetail,
	IssueSummary,
	UnblockUserResult,
	ListDeliveriesInput,
	ListEffectsInput,
	ListVerdictsInput,
	ListActivityInput,
	ActivityItem,
	ActivityOutcome,
	Overview,
	Page,
	RemoveAllowedUserResult,
	Resolved,
	SessionUser,
	VerdictSummary,
	IntroductionClosedItem,
	IntroductionCounts,
	IntroductionSetupStatus,
	IntroductionSummary,
	ListIntroductionsInput
} from '../schemas/api';
import { formatAddress, issueAddressFromKey, parseIssueKey, reopenEffectKey, type ActorAddress } from '../schemas/actors';
import { AdminStore, AdminStoreError } from './admins';
import { log } from './log';
import { masterKeyStatus } from './secrets';
import type {
	DevInfo,
	DevTool,
	DevInjectFaultInput,
	DevInjectFaultResult,
	DevOpenIssueInput,
	DevOpenIssueResult,
	DevRedeliverResult,
	DevReopenIssueInput,
	DevDeleteIssueInput,
	DevDeleteIssueResult,
	DevSetUpDiscussionsInput,
	DevIntroduceInput,
	DevIntroduceResult,
	DevReopenIssueResult,
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
import { parseIssuesWebhook, parsePullRequestWebhook } from '../schemas/github';
import { issueKey } from '../schemas/actors';
import { parse, SchemaValidationError } from '../schemas/standard';
import {
	SESSION_TTL_MS,
	isApprovePayload,
	parseClosePayload,
	parseOutboxPayload,
	parseReplyTo,
	type AllowedUserRow,
	type BlockedUserRow,
	type InboxRow,
	type OutboxRow,
	type VerdictRow
} from '../schemas/wal';
import {
	CONTROL_PATHS,
	ControlOk,
	CreateIssueResponse,
	CreatePullRequestResponse,
	EnsureRepoResponse,
	InjectFaultResponse,
	RedeliverResponse,
	ReopenIssueResponse,
	DeleteIssueResponse,
	CreateDiscussionResponse,
	FakeCategory,
	parseFakeState
} from '../../../fake-github/schemas';
import { BackendError, type Backend } from './backend';
import type { AddAdminResult, Admin, AuditEntry, CreatedLoginLink, CreateLoginLinkInput, LoginLinkSummary, RemoveAdminResult, RevokeLoginLinkResult, SetupStatus } from '../schemas/admins';
import type {
	BeginManifestInput,
	CompleteManifestResult,
	GitHubStatus,
	InstallationSummary,
	ManifestFormData,
	RepoSummary,
	SetRepoEnabledInput
} from '../schemas/github-app';
import { issueName, type Runtime } from './system';
import { findActor } from '../charts/runtime';
import { detailOfActor, snapshotOf, summaryOfActor } from './inspect/snapshot';
import { destinationConsoleLink, getOpsBackend, hasOpsBackend, type OpsStatus } from '$lib/ops/contract';
import { setupSteps } from './setup-steps';
import { EVENTS, issueKey as itemKey } from '../schemas/actors';
import { AuthorAssociation } from '../schemas/github';
import { check as checkSchema } from '../schemas/standard';
import { DEFAULT_APPROVED_TEMPLATE } from '../schemas/message-template';
import { decidePolicy } from './policy';
import {
	INTRODUCTIONS_CATEGORY,
	INTRODUCTIONS_CATEGORY_DESCRIPTION,
	readApprovedTemplate,
	readOrgRepositories,
	saveApprovedTemplate as storeApprovedTemplate,
	setOrgRepository as storeOrgRepository
} from './introductions';
import type { IntroductionRow } from '../schemas/wal';

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


export class RealBackend implements Backend {
	readonly #rt: Runtime;

	readonly #admins: AdminStore;

	constructor(runtime: Runtime) {
		this.#rt = runtime;
		this.#admins = new AdminStore(runtime.wal.db);
	}

	/** Admins, login links, audit and settings (ADR 0161); shared with the admin socket. */
	get adminStore(): AdminStore {
		return this.#admins;
	}

	/** Public URL for links (ORIGIN, else the local port). */
	get origin(): string {
		return this.#rt.config.origin ?? `http://localhost:${this.#rt.config.port}`;
	}

	#adminCall<T>(fn: () => T): T {
		try {
			return fn();
		} catch (e) {
			if (e instanceof AdminStoreError) throw new BackendError(e.code, e.message);
			throw e;
		}
	}

	get #wal() {
		return this.#rt.wal;
	}

	#user(login: string, avatarUrl: string | null): SessionUser {
		return { login, avatarUrl, isAdmin: this.#admins.isAdmin(login) };
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
		if (row?.event === 'pull_request') {
			try {
				const p = parsePullRequestWebhook(row.payload);
				const pr = p.pull_request;
				return {
					kind: 'pull_request',
					repoId: p.repository.id,
					owner: p.repository.owner.login,
					repo: p.repository.name,
					number: pr.number,
					title: pr.title,
					author: pr.user.login,
					association: pr.author_association,
					htmlUrl: pr.html_url
				};
			} catch {
				return null;
			}
		}
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
			ignoreReason: row.ignore_reason ?? null,
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
		const stats = await this.#rt.host.hostStats();
		const byFamily: Record<string, number> = {};
		for (const c of stats.charts) if (c.actors) byFamily[c.name] = (byFamily[c.name] ?? 0) + c.actors;
		const sum = (f: (c: (typeof stats.charts)[number]) => number) => stats.charts.reduce((n, c) => n + f(c), 0);
		return {
			inbox: this.#wal.inboxCounts(),
			outbox: this.#wal.outboxCounts(),
			verdicts: this.#wal.verdictCounts(),
			allowlistSize: this.#wal.allowedCount(),
			system: {
				residentActors: stats.host.actors - stats.host.hibernated,
				actorsByFamily: byFamily,
				runnableActors: stats.host.runnable,
				deliveredMessages: stats.host.delivered,
				faults: sum((c) => c.faults),
				errors: sum((c) => c.errorsExecution + c.errorsCommunication),
				memoryBytes: stats.host.regionBytes,
				startedAt: this.#rt.startedAt
			},
			nextRelayAttemptAt: this.#wal.nextOutboxDueAt(),
			generatedAt: Date.now()
		};
	}

	async listDeliveries(q: Resolved<ListDeliveriesInput>): Promise<Page<DeliverySummary>> {
		const offset = cursorOffset(q.before);
		const rows = this.#wal.listInbox(q.state, q.limit + 1, offset, q.about);
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

	async listActivity(q: Resolved<ListActivityInput>): Promise<Page<ActivityItem>> {
		const offset = cursorOffset(q.before);
		const rows = this.#wal.listActivity({ ...(q.outcome ? { outcome: q.outcome } : {}), ...(q.kind ? { kind: q.kind } : {}) }, q.limit + 1, offset);
		const items = rows.map((r): ActivityItem => {
			const verdict = this.#wal.getVerdict(r.issueKey);
			const outbox = this.#wal.outboxForIssue(r.issueKey);
			const latest = this.#wal.inboxForIssue(r.issueKey)[0] ?? null;
			return {
				issueKey: r.issueKey,
				kind: r.kind,
				outcome: r.outcome as ActivityOutcome,
				updatedAt: r.updatedAt,
				issue: this.#issueSummary(this.#wal.latestIssuesInbox(r.issueKey)),
				decision: verdict ? { verdict: verdict.verdict, reason: verdict.reason, decidedAt: verdict.decided_at } : null,
				action: outbox ? { state: outbox.state, attempts: outbox.attempts, lastError: outbox.last_error, updatedAt: outbox.updated_at } : null,
				reopen: this.#reopenOf(r.issueKey),
				latestDelivery: latest
					? { deliveryId: latest.delivery_id, event: latest.event, action: latest.action, state: latest.state, ignoreReason: latest.ignore_reason ?? null, receivedAt: latest.received_at }
					: null
			};
		});
		return offsetPage(items, q.limit, offset);
	}

	#reopenOf(key: string): ActivityItem['reopen'] {
		const { repoId, number } = parseIssueKey(key);
		const row = this.#wal.getOutbox(reopenEffectKey(repoId, number));
		return row ? { state: row.state, attempts: row.attempts, lastError: row.last_error, updatedAt: row.updated_at } : null;
	}

	async getIssue(key: string): Promise<IssueDetail | null> {
		const { repoId, number } = parseIssueKey(key);
		const inbox = this.#wal.inboxForIssue(key);
		const outbox = this.#wal.outboxForIssue(key);
		const verdict = this.#wal.getVerdict(key);
		const reopen = this.#wal.getOutbox(reopenEffectKey(repoId, number));
		const actor = findActor(this.#rt.host, issueName(key));
		const detail = actor ? await this.#live(() => detailOfActor(actor, issueName(key))) : null;
		if (!inbox.length && !outbox && !verdict && !detail) return null;
		return {
			issueKey: key,
			repoId,
			number,
			issue: this.#issueSummary(this.#wal.latestIssuesInbox(key)),
			deliveries: inbox.map((r) => this.#delivery(r)),
			effect: outbox ? this.#effect(outbox) : null,
			reopen: reopen ? this.#effect(reopen) : null,
			verdict: verdict ? this.#verdict(verdict) : null,
			actor: detail
		};
	}

	// -- allowlist --------------------------------------------------------------------

	async listAllowedUsers(): Promise<AllowedUser[]> {
		return this.#wal.listAllowedUsers().map(allowedUser);
	}

	async addAllowedUser(login: string, addedBy: string, scope = ''): Promise<AddAllowedUserResult> {
		const { row, added } = this.#wal.addAllowedUser(login, addedBy, { scope });
		if (added) {
			this.#rt.publishAllowlist();
			const subject = row.scope ? `${row.login} (${row.scope})` : row.login;
			log.info(`allowlist: ${subject} added by ${addedBy}`, { 'audit.action': 'allowlist.add', 'audit.subject': subject, 'audit.actor': addedBy });
		}
		return { user: allowedUser(row), added };
	}

	async admitAuthor(key: string, scope: AdmitScope, by: string): Promise<AdmitAuthorResult> {
		const close = this.#wal.outboxForIssue(key);
		if (!close) {
			if (!this.#wal.getVerdict(key) && !this.#wal.inboxForIssue(key).length) throw new BackendError('not-found', `No item ${key}`);
			throw new BackendError('conflict', 'granary did not close this item');
		}
		const item = parseClosePayload(close.payload);
		const login = item.author;
		const entryScope = scope === 'everywhere' ? '' : scope === 'owner' ? item.owner.toLowerCase() : `${item.owner}/${item.repo}`.toLowerCase();
		const now = Date.now();
		const { added, unblocked, reopening } = this.#wal.tx(() => {
			const block = this.#wal.getBlockedUser(login);
			const unblocked = block !== null && (block.expires_at === null || block.expires_at > now) && this.#wal.unblockUser(block.login);
			const { added } = this.#wal.addAllowedUser(login, by, { scope: entryScope, note: `activity ${item.owner}/${item.repo}#${item.number}` }, now);
			const reopening: string[] = [];
			for (const c of this.#wal.closedItemsOf(login, entryScope)) {
				const effectKey = reopenEffectKey(c.repoId, c.number);
				const { inserted, row } = this.#wal.insertOutbox(
					{ effectKey, issueKey: itemKey(c.repoId, c.number), replyTo: issueAddressFromKey(itemKey(c.repoId, c.number)), payload: { effect: 'reopen', ...c, author: login, scope: entryScope, by } },
					now
				);
				// Asked again after it gave up: try again.
				if (!inserted && row.state === 'dead') this.#wal.retryOutbox(effectKey, now);
				reopening.push(`${c.owner}/${c.repo}#${c.number}`);
			}
			return { added, unblocked, reopening };
		});
		const subject = entryScope ? `${login} (${entryScope})` : login;
		if (unblocked) {
			this.#admins.audit(by, 'blocklist.remove', login, { via: `activity ${key}` });
			this.#rt.publishBlocklist();
		}
		if (added) this.#rt.publishAllowlist();
		this.#rt.relay.kick();
		log.info(`allowlist: ${by} let ${subject} in from activity (${item.owner}/${item.repo}#${item.number}), reopening ${reopening.length}${unblocked ? ', block lifted' : ''}`, {
			'audit.action': 'allowlist.admit',
			'audit.subject': subject,
			'audit.actor': by,
			'github.repository': `${item.owner}/${item.repo}`,
			'github.issue.number': item.number
		});
		return { login, scope: entryScope, added, unblocked, reopening };
	}

	async removeAllowedUser(login: string, removedBy: string, scope = ''): Promise<RemoveAllowedUserResult> {
		const removed = this.#wal.removeAllowedUser(login, scope.toLowerCase());
		if (removed) {
			this.#rt.publishAllowlist();
			const subject = scope ? `${login} (${scope.toLowerCase()})` : login;
			log.info(`allowlist: ${subject} removed by ${removedBy}`, { 'audit.action': 'allowlist.remove', 'audit.subject': subject, 'audit.actor': removedBy });
		}
		return { login, scope: scope.toLowerCase(), removed };
	}

	// -- introductions (ADR 0310) ---------------------------------------------------------

	#introduction(r: IntroductionRow): IntroductionSummary {
		const assoc = checkSchema(AuthorAssociation, r.author_association) ? r.author_association : 'NONE';
		const verdict = decidePolicy({ allowed: this.#wal.allowlistEntries(), blocked: this.#wal.blocklistEntries() }, { login: r.author, association: assoc, owner: r.owner, repo: r.repo });
		const closedItems: IntroductionClosedItem[] = this.#wal
			.closedItemsOf(r.author, r.scope)
			.map((i) => ({ kind: i.kind, issueKey: itemKey(i.repoId, i.number), owner: i.owner, repo: i.repo, number: i.number, title: i.title, htmlUrl: i.htmlUrl }));
		const effect = this.#wal.getOutbox(`approve:${r.repo_id}:${r.number}`);
		const effectPayload = effect ? parseOutboxPayload(effect.payload) : null;
		const reopened: IntroductionClosedItem[] =
			effectPayload && isApprovePayload(effectPayload)
				? effectPayload.reopen.map((i) => ({ kind: i.kind, issueKey: itemKey(i.repoId, i.number), owner: i.owner, repo: i.repo, number: i.number, title: i.title, htmlUrl: i.htmlUrl }))
				: [];
		return {
			introKey: r.intro_key,
			owner: r.owner,
			repo: r.repo,
			number: r.number,
			author: r.author,
			association: r.author_association,
			title: r.title,
			body: r.body,
			htmlUrl: r.html_url,
			scope: r.scope,
			state: r.state,
			receivedAt: r.received_at,
			updatedAt: r.updated_at,
			decidedBy: r.decided_by,
			decidedAt: r.decided_at,
			note: r.note,
			policy: { allowed: verdict.allowed, reason: verdict.reason },
			closedItems,
			reopened,
			action: effect ? { state: effect.state, attempts: effect.attempts, lastError: effect.last_error, effectKey: effect.effect_key } : null
		};
	}

	#introductionRow(introKey: string): IntroductionRow {
		const row = this.#wal.getIntroduction(introKey);
		if (!row) throw new BackendError('not-found', `No introduction ${introKey}`);
		return row;
	}

	async listIntroductions(input: ListIntroductionsInput): Promise<IntroductionSummary[]> {
		return this.#wal.listIntroductions(input.state, 200, 0).map((r) => this.#introduction(r));
	}

	async introductionCounts(): Promise<IntroductionCounts> {
		return this.#wal.introductionCounts();
	}

	async approveIntroduction(introKey: string, by: string): Promise<IntroductionSummary> {
		const row = this.#introductionRow(introKey);
		if (row.state !== 'pending' && row.state !== 'failed' && row.state !== 'approving') throw new BackendError('conflict', `This introduction is ${row.state}`);
		this.#rt.introductionActor(introKey).send(EVENTS.introductionApprove, { by });
		log.info(`introduction/${introKey} approved by ${by}`, { 'audit.action': 'introduction.approve', 'audit.subject': introKey, 'audit.actor': by });
		return this.#introduction(this.#introductionRow(introKey));
	}

	async declineIntroduction(introKey: string, by: string, note: string | null): Promise<IntroductionSummary> {
		const row = this.#introductionRow(introKey);
		if (row.state !== 'pending') throw new BackendError('conflict', `This introduction is ${row.state}`);
		this.#rt.introductionActor(introKey).send(EVENTS.introductionDecline, { by, note });
		log.info(`introduction/${introKey} declined by ${by}`, { 'audit.action': 'introduction.decline', 'audit.subject': introKey, 'audit.actor': by });
		return this.#introduction(this.#introductionRow(introKey));
	}

	async introductionSetup(): Promise<IntroductionSetupStatus> {
		const web = this.#rt.config.githubWebUrl.replace(/\/+$/, '');
		const connected = this.#rt.github.mode() === 'app';
		return {
			connected,
			access: connected ? this.#rt.github.discussionAccess() : null,
			entries: connected
				? this.#rt.introductions.entries().map(({ target, check }) => {
						const repoUrl = `${web}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
						return {
							owner: target.owner,
							repo: target.repo,
							org: target.org,
							state: check?.state ?? 'unchecked',
							error: check?.error ?? null,
							checkedAt: check?.checked_at ?? null,
							newUrl: check?.new_url ?? null,
							settingsUrl: `${repoUrl}/settings`,
							newCategoryUrl: `${repoUrl}/discussions/categories/new`
						};
					})
				: [],
			orgRepositories: readOrgRepositories(this.#wal.db),
			category: { ...INTRODUCTIONS_CATEGORY, description: INTRODUCTIONS_CATEGORY_DESCRIPTION },
			approvedTemplate: { ...readApprovedTemplate(this.#wal.db), default: DEFAULT_APPROVED_TEMPLATE }
		};
	}

	async checkIntroductionSetup(): Promise<IntroductionSetupStatus> {
		await this.#rt.github.status();
		await this.#rt.introductions.checkAll();
		return this.introductionSetup();
	}

	async setOrgRepository(owner: string, repo: string | null, by: string): Promise<IntroductionSetupStatus> {
		try {
			storeOrgRepository(this.#wal.db, owner, repo, by);
		} catch (e) {
			if (e instanceof AdminStoreError) throw new BackendError('invalid', e.message);
			throw e;
		}
		await this.#rt.introductions.checkAll();
		return this.introductionSetup();
	}

	async saveApprovedTemplate(template: string | null, by: string): Promise<IntroductionSetupStatus> {
		try {
			storeApprovedTemplate(this.#wal.db, template, by);
		} catch (e) {
			if (e instanceof AdminStoreError) throw new BackendError('invalid', e.message);
			throw e;
		}
		return this.introductionSetup();
	}

	// -- blocklist (ADR 0260) -------------------------------------------------------------

	#blocked(r: BlockedUserRow, now = Date.now()): BlockedUser {
		return {
			login: r.login,
			note: r.note,
			expiresAt: r.expires_at,
			addedBy: r.added_by,
			addedAt: r.added_at,
			active: r.expires_at === null || r.expires_at > now,
			isAdmin: this.#admins.isAdmin(r.login)
		};
	}

	async listBlockedUsers(): Promise<BlockedUser[]> {
		const now = Date.now();
		return this.#wal.listBlockedUsers().map((r) => this.#blocked(r, now));
	}

	async blockUser(input: BlockUserRequest, actor: string): Promise<BlockUserResult> {
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(\[bot\])?$/.test(input.login))
			throw new BackendError('invalid', `Not a valid GitHub login: ${input.login}`);
		if (input.forMs !== null && (!Number.isInteger(input.forMs) || input.forMs < 1000))
			throw new BackendError('invalid', 'A block must last at least one second');
		const now = Date.now();
		const expiresAt = input.forMs === null ? null : now + input.forMs;
		const note = input.note?.trim() ? input.note.trim() : null;
		const { row, added } = this.#wal.blockUser(input.login, { note, expiresAt, addedBy: actor }, now);
		this.#admins.audit(actor, 'blocklist.add', row.login, { expiresAt, note });
		this.#rt.publishBlocklist();
		log.info(`blocklist: ${actor} blocked ${row.login}${expiresAt ? ` until ${new Date(expiresAt).toISOString()}` : ' until removed'}`);
		return { user: this.#blocked(row, now), added };
	}

	async unblockUser(login: string, actor: string): Promise<UnblockUserResult> {
		const existing = this.#wal.getBlockedUser(login);
		const removed = this.#wal.unblockUser(login);
		if (removed) {
			this.#admins.audit(actor, 'blocklist.remove', existing?.login ?? login, null);
			this.#rt.publishBlocklist();
			log.info(`blocklist: ${actor} unblocked ${existing?.login ?? login}`);
		}
		return { login: existing?.login ?? login, removed };
	}

	// -- effects ------------------------------------------------------------------------

	async retryEffect(effectKey: string, requestedBy: string): Promise<EffectSummary> {
		const row = this.#wal.getOutbox(effectKey);
		if (!row) throw new BackendError('not-found', `No effect ${effectKey}`);
		if (row.state === 'done' || row.state === 'inflight')
			throw new BackendError('conflict', `Effect ${effectKey} is ${row.state}`);
		const updated = this.#wal.retryOutbox(effectKey);
		this.#rt.relay.kick();
		log.info(`relay: ${effectKey} retried by ${requestedBy}`, { 'audit.action': 'effect.retry', 'audit.subject': effectKey, 'audit.actor': requestedBy, 'relay.effect_key': effectKey });
		return this.#effect(updated);
	}

	// -- actors ---------------------------------------------------------------------------

	/** `f()`, or null when the actor ended meanwhile. */
	async #live<T>(f: () => Promise<T>): Promise<T | null> {
		try {
			return await f();
		} catch (e) {
			if (e instanceof StaleError) return null;
			throw e;
		}
	}

	async listActors(): Promise<ActorSummary[]> {
		const actors: Actor[] = await this.#rt.host.actors();
		const summaries = await Promise.all(actors.map((a) => this.#live(() => summaryOfActor(a, this.#rt.nameOf(a)))));
		return summaries
			.filter((s): s is ActorSummary => s !== null)
			.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
	}

	async inspectActor(address: ActorAddress): Promise<ActorSnapshot | null> {
		const name = formatAddress(address);
		const actor = findActor(this.#rt.host, name);
		return actor ? this.#live(() => snapshotOf(actor, name)) : null;
	}

	// -- dev ------------------------------------------------------------------------------

	async #control<S extends TSchema>(method: 'GET' | 'POST', path: string, schema: S, body?: unknown): Promise<Static<S>> {
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
		const c = this.#rt.config;
		const tools: DevTool[] = [
			{ id: 'ops', name: 'Ops', url: '/ops', description: 'Backups, telemetry and self-healing', group: 'granary', up: null, external: false },
			{ id: 'fake-github', name: 'Fake GitHub', url: `${c.fakeGithubUrl}/`, description: 'Open issues as anyone, faults, deliveries', group: 'fakes', up: null, external: true },
			{ id: 'fake-infra', name: 'Fake infra', url: `${c.fakeInfraUrl}/`, description: 'Fake R2, OTLP receiver, exe.dev proxy', group: 'fakes', up: null, external: true },
			{ id: 'loadgen', name: 'Load generator', url: '/admin/load', description: `Scenarios and personas (API ${c.loadgenUrl})`, group: 'fakes', up: null, external: false }
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
		const base = {
			fakeGithubUrl: this.#rt.config.fakeGithubUrl,
			admins: this.#admins.listAdmins().map((a) => a.login)
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
		const { kind = 'issue', draft, ...fields } = input;
		const created =
			kind === 'pull_request'
				? await this.#control('POST', CONTROL_PATHS.pulls, CreatePullRequestResponse, { ...fields, ...(draft ? { draft } : {}) })
				: await this.#control('POST', CONTROL_PATHS.issues, CreateIssueResponse, fields);
		return {
			kind,
			number: created.number,
			deliveryId: created.deliveryId,
			repoId: repo.id,
			issueKey: issueKey(repo.id, created.number)
		};
	}

	async devReopenIssue(input: DevReopenIssueInput): Promise<DevReopenIssueResult> {
		return this.#control('POST', CONTROL_PATHS.reopen, ReopenIssueResponse, input);
	}

	async devDeleteIssue(input: DevDeleteIssueInput): Promise<DevDeleteIssueResult> {
		return this.#control('POST', CONTROL_PATHS.deleteIssue, DeleteIssueResponse, input);
	}

	async devSetUpDiscussions(input: DevSetUpDiscussionsInput): Promise<void> {
		await this.#control('POST', CONTROL_PATHS.repos, EnsureRepoResponse, { owner: input.owner, name: input.repo });
		await this.#control('POST', CONTROL_PATHS.discussionsEnabled, ControlOk, { owner: input.owner, repo: input.repo, enabled: true });
		await this.#control('POST', CONTROL_PATHS.discussionCategories, FakeCategory, { owner: input.owner, repo: input.repo, name: 'Introductions', emoji: ':wave:' });
		await this.#control('POST', CONTROL_PATHS.discussionCategories, FakeCategory, { owner: input.owner, repo: input.repo, name: 'General' });
		await this.#rt.introductions.check(input.owner, input.repo);
	}

	async devIntroduce(input: DevIntroduceInput): Promise<DevIntroduceResult> {
		const r = await this.#control('POST', CONTROL_PATHS.discussions, CreateDiscussionResponse, {
			owner: input.owner,
			repo: input.repo,
			author: input.author,
			category: input.category ?? 'introductions',
			title: input.title,
			...(input.body ? { body: input.body } : {})
		});
		return { number: r.number, deliveryId: r.deliveryId };
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

	async getRecentSpans(q: Resolved<GetRecentSpansInput>): Promise<SpanSummary[]> {
		return this.#rt.tracer.recent(q);
	}

	async listRecentTraces(q: Resolved<ListRecentTracesInput>): Promise<TraceSummary[]> {
		return this.#rt.tracer.traces(q);
	}

	// -- load generator (ADR 0076) ------------------------------------------------------

	#loadgenClient: LoadgenClient | null = null;
	get #loadgen(): LoadgenClient {
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

	// -- setup, admins, login links (ADR 0161) --

	#pending(fork: string): never {
		throw new BackendError('unavailable', `not implemented yet (ADR 0166, fork ${fork})`);
	}
	async getSetupStatus(): Promise<SetupStatus> {
		const c = this.#rt.config;
		const adminCount = this.#admins.adminCount();
		const github = await this.#rt.github.status();
		let ops: OpsStatus | null = null;
		let opsError: string | null = null;
		if (hasOpsBackend()) {
			try {
				ops = await getOpsBackend().getStatus();
			} catch (e) {
				opsError = e instanceof Error ? e.message : String(e);
			}
		}
		return {
			state: this.#admins.setupState(),
			origin: c.origin,
			masterKey: masterKeyStatus(),
			adminCount,
			steps: setupSteps({ adminCount, github, ops, opsError })
		};
	}
	async getClosingMessages(): Promise<{ messages: ClosingMessages; updatedBy: string | null; updatedAt: number | null }> {
		const row = this.#admins.getSetting(CLOSING_MESSAGES_SETTING);
		return { messages: readClosingMessages(this.#wal.db), updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
	}
	async saveClosingMessages(messages: ClosingMessages, actor: string): Promise<ClosingMessages> {
		const saved = this.#adminCall(() => saveClosingMessages(this.#wal.db, messages, 'ui', actor));
		log.info('settings: closing message changed', { 'user.login': actor, 'granary.setting': 'messages.closing' });
		return saved;
	}
	async listAdmins(): Promise<Admin[]> {
		return this.#admins.listAdmins();
	}
	async addAdmin(login: string, addedBy: string, source: Admin['source']): Promise<AddAdminResult> {
		return this.#adminCall(() => this.#admins.addAdmin(login, addedBy, source));
	}
	async removeAdmin(login: string, removedBy: string): Promise<RemoveAdminResult> {
		return this.#adminCall(() => this.#admins.removeAdmin(login, removedBy));
	}
	async createLoginLink(input: CreateLoginLinkInput, createdBy: string): Promise<CreatedLoginLink> {
		const origin = this.#rt.config.origin;
		// A link is only useful at the public URL: never fall back to localhost (ADR 0232).
		if (!origin) throw new BackendError('invalid', 'ORIGIN is not set: set ORIGIN=https://… in granary.env and restart granary, then create the link again');
		return this.#adminCall(() => this.#admins.createLoginLink(input, createdBy, origin));
	}
	async consumeLoginLink(token: string): Promise<CreatedSession | null> {
		const login = this.#admins.consumeLoginLink(token);
		return login ? this.createSession({ login }) : null;
	}
	async listAuditLog(limit: number): Promise<AuditEntry[]> {
		return this.#admins.listAudit(limit);
	}
	async listLoginLinks(limit: number): Promise<LoginLinkSummary[]> {
		return this.#admins.listLoginLinks(limit);
	}
	async revokeLoginLink(id: string, revokedBy: string): Promise<RevokeLoginLinkResult> {
		return this.#adminCall(() => this.#admins.revokeLoginLink(id, revokedBy));
	}

	// -- GitHub connection (ADR 0160, 0162): src/lib/server/github/connection.ts -------------

	async getGitHubStatus(): Promise<GitHubStatus> {
		return this.#rt.github.status();
	}
	async beginGitHubAppManifest(input: BeginManifestInput, requestedBy: string): Promise<ManifestFormData> {
		return this.#rt.github.beginManifest(input, requestedBy);
	}
	async completeGitHubAppManifest(code: string, state: string, actor: string): Promise<CompleteManifestResult> {
		const r = await this.#rt.github.completeManifest(code, state, actor);
		this.#admins.audit(actor, 'github.app.create', r.slug, { appId: r.appId });
		return r;
	}
	async disconnectGitHub(actor: string): Promise<GitHubStatus> {
		const before = this.#rt.github.mode();
		this.#rt.github.disconnect(actor);
		this.#admins.audit(actor, 'github.disconnect', before, null);
		return this.getGitHubStatus();
	}
	async dismissGitHubLogoHint(actor: string): Promise<GitHubStatus> {
		this.#rt.github.dismissLogoHint(actor);
		const status = await this.getGitHubStatus();
		this.#admins.audit(actor, 'github.logo.dismiss', status.app?.slug ?? '', null);
		return status;
	}
	async refreshGitHubInstallations(actor: string): Promise<InstallationSummary[]> {
		return this.#rt.github.refreshInstallations(actor);
	}
	async setRepoEnabled(input: SetRepoEnabledInput, actor: string): Promise<RepoSummary> {
		const repo = await this.#rt.github.setRepoEnabled(input, actor);
		this.#admins.audit(actor, input.enabled ? 'github.repo.enable' : 'github.repo.disable', repo.fullName, null);
		return repo;
	}

	// -- fake-infra (ADR 0139) ---------------------------------------------------

	#fakeInfraClient: FakeInfraClient | null = null;
	get #fakeInfra(): FakeInfraClient {
		return (this.#fakeInfraClient ??= new FakeInfraClient(this.#rt.config.fakeInfraUrl));
	}
	getFakeInfraStatus(): Promise<FakeInfraInfo> {
		return this.#fakeInfra.info();
	}
	fakeInfraControl(action: FakeInfraAction): Promise<FakeInfraActionResult> {
		return this.#fakeInfra.control(action);
	}
}

/** An allowed_users row as the API shows it (ADR 0311). */
function allowedUser(r: AllowedUserRow): AllowedUser {
	return { login: r.login, scope: r.scope, note: r.note, addedBy: r.added_by, addedAt: r.added_at };
}
