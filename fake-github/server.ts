/**
 * Fake GitHub (ADR 0006, ADR 0035, ADR 0060): a separate Bun process with
 * its own tinyactors System emulating the subset of GitHub granary uses —
 * REST (issues, comments), webhooks, OAuth — plus the `/__control` API and
 * a small HTML page at `/`.
 *
 * Env: FAKE_GITHUB_PORT (4010), FAKE_GITHUB_URL (public base, default
 * http://localhost:$PORT), FAKE_GITHUB_WEBHOOK_URL, GITHUB_WEBHOOK_SECRET,
 * GITHUB_OAUTH_CLIENT_ID / _SECRET (checked when set),
 * OTEL_EXPORTER_OTLP_ENDPOINT (traces with service.name=fake-github).
 */
import type { TSchema, Static } from '@sinclair/typebox';
import {
	CONTROL_PATHS,
	CreateCommentControlRequest,
	CreateIssueRequest,
	RawDeliveryRequest,
	EnsureRepoRequest,
	EnsureUserRequest,
	InjectFaultRequest,
	ReopenIssueRequest,
	WebhookOutageRequest,
	type ControlError,
	type CreateCommentControlResponse,
	type CreateIssueResponse,
	type EventsLogResponse,
	type RawDeliveryResponse,
	type EnsureRepoResponse,
	type FakeUser,
	type InjectFaultResponse,
	type RedeliverResponse,
	type ReopenIssueResponse
} from './schemas';
import {
	CreateCommentRequest,
	OAuthAccessTokenRequest,
	OAuthAuthorizeQuery,
	UpdateIssueRequest,
	type AuthenticatedUser,
	type GitHubUser,
	type Issue,
	type IssueComment
} from '../src/lib/schemas/github';
import { issuesOf } from '../src/lib/schemas/standard';
import { ask, isFailure, waitForReply } from './io/reply';
import { createFakeSystem } from './system';
import { nextId } from './ids';
import { REGISTRY_ADDRESS, REGISTRY_EVENTS, type EnsureRepoResult } from './actors/registry';
import { FAULTS_ADDRESS, FAULT_EVENTS, type FaultHit } from './actors/faults';
import { OAUTH_ADDRESS, OAUTH_EVENTS } from './actors/oauth';
import { REPOSITORY_EVENTS, repositoryAddress } from './actors/repository';
import { DELIVERY_EVENTS, deliveryAddress, type DeliveryReply } from './actors/delivery';
import { issuesEvent, repositoryView, userView, type Bases } from './views';
import { authorizePage, controlPage } from './page';
import { EventLog } from './events';
import { createAppRoutes, type DeliveryTarget } from './app-routes';
import { APPS_ADDRESS, APPS_EVENTS, repoCovered, type AppRecord, type Covering, type InstallationRecord } from './actors/apps';

const env = process.env;
const nonEmpty = (v: string | undefined) => (v && v.length ? v : undefined);

const port = Number(nonEmpty(env.FAKE_GITHUB_PORT) ?? 4010);
const base = (nonEmpty(env.FAKE_GITHUB_URL) ?? `http://localhost:${port}`).replace(/\/+$/, '');
const bases: Bases = { web: base, api: base };
const webhookUrl = () => nonEmpty(env.FAKE_GITHUB_WEBHOOK_URL) ?? 'http://localhost:5173/webhook';
const webhookSecret = () => nonEmpty(env.GITHUB_WEBHOOK_SECRET) ?? 'dev-webhook-secret';
const oauthClientId = nonEmpty(env.GITHUB_OAUTH_CLIENT_ID);
const oauthClientSecret = nonEmpty(env.GITHUB_OAUTH_CLIENT_SECRET);
/** The user behind the app's REST token (anything that is not an OAuth token). */
const BOT_LOGIN = 'granary[bot]';

/** ADR 0164: while true, every webhook delivery fails with status_code 0. */
let webhookOutage = false;

const fake = createFakeSystem({
	webhook: { url: webhookUrl, secret: webhookSecret, outage: () => webhookOutage },
	otlpEndpoint: nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? null,
	outage: () => webhookOutage
});
const { system } = fake;
/** ADR 0075: what happened, for subscribers such as loadgen. */
const events = new EventLog();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	Response.json(body, { status, headers });
const controlError = (status: number, error: string, issues?: ControlError['issues']) =>
	json(issues ? { error, issues } : { error }, status);
const githubError = (status: number, message: string, extra: Record<string, string> = {}) =>
	json({ message, documentation_url: 'https://docs.github.com/rest' }, status, extra);

class HttpError extends Error {
	constructor(
		readonly response: Response
	) {
		super('http error');
	}
}

async function readJson(req: Request, { allowEmpty = false } = {}): Promise<unknown> {
	const text = await req.text();
	if (!text.trim()) {
		if (allowEmpty) return undefined;
		throw new HttpError(controlError(400, 'Request body must be JSON'));
	}
	try {
		return JSON.parse(text);
	} catch (e) {
		throw new HttpError(controlError(400, `Malformed JSON: ${(e as Error).message}`));
	}
}

/** Validate a control body (closed schema) or throw 400 ControlError. */
function validate<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	const issues = issuesOf(schema, value);
	if (issues.length) throw new HttpError(controlError(400, `Invalid ${what}`, issues));
	return value as Static<T>;
}

/** Unwrap an actor result; an ActorFailure becomes an HttpError via `onFail`. */
function unwrap<T>(result: unknown, onFail: (status: number, msg: string) => Response): T {
	if (isFailure(result)) throw new HttpError(onFail(result.status, result.error));
	return result as T;
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Domain operations (each goes through the actors)
// ---------------------------------------------------------------------------

async function ensureUser(login: string, type?: FakeUser['type']): Promise<FakeUser> {
	return ask<FakeUser>(system, REGISTRY_ADDRESS, REGISTRY_EVENTS.ensureUser, { login, type, newId: nextId() });
}

async function getUser(login: string): Promise<FakeUser | null> {
	return ask<FakeUser | null>(system, REGISTRY_ADDRESS, REGISTRY_EVENTS.getUser, { login });
}

async function ensureRepo(owner: string, name: string): Promise<EnsureRepoResult> {
	const result = await ask<EnsureRepoResult>(system, REGISTRY_ADDRESS, REGISTRY_EVENTS.ensureRepo, {
		owner,
		name,
		newRepoId: nextId(),
		newOwnerId: nextId()
	});
	const address = repositoryAddress(result.repo.id);
	if (!system.findActor(address)) {
		system.spawn(fake.definitions.repository, {
			address,
			binding: {
				id: result.repo.id,
				owner: result.repo.owner,
				ownerId: result.owner.id,
				name: result.repo.name,
				webBase: bases.web,
				apiBase: bases.api,
				nextNumber: 1,
				issues: [],
				out: null
			}
		});
	}
	return result;
}

/** The repo and its owner, or null when unknown. */
async function findRepo(owner: string, name: string) {
	const repo = await ask<EnsureRepoResult['repo'] | null>(system, REGISTRY_ADDRESS, REGISTRY_EVENTS.findRepo, {
		owner,
		name
	});
	if (!repo || !system.findActor(repositoryAddress(repo.id))) return null;
	const ownerUser = (await getUser(repo.owner)) ?? (await ensureUser(repo.owner));
	return { repo, owner: ownerUser };
}

/** Delivery metadata for the event log (attempt counts, redelivery). Bounded. */
const deliveryMeta = new Map<
	string,
	{ event: string; action: string; repoId: number | null; number: number | null; attempts: number; appId?: number | null; installationId?: number | null }
>();

/** Record a finished delivery attempt in the event log. */
function emitDelivery(r: DeliveryReply, event: string, action: string, repoId: number | null, number: number | null) {
	const meta = deliveryMeta.get(r.deliveryId) ?? { event, action, repoId, number, attempts: 0 };
	meta.attempts += 1;
	deliveryMeta.set(r.deliveryId, meta);
	if (deliveryMeta.size > 50_000) deliveryMeta.delete(deliveryMeta.keys().next().value!);
	events.emit({
		type: 'delivery',
		deliveryId: r.deliveryId,
		event,
		action,
		repoId,
		number,
		responseCode: r.responseCode,
		attempt: meta.attempts
	});
}

/** Spawn a delivery actor for `body` and wait for its first attempt. */
async function deliver(
	action: string,
	body: string,
	repoId: number | null,
	issueNumber: number | null,
	event = 'issues',
	id: string = crypto.randomUUID(),
	target: DeliveryTarget | null = null
): Promise<DeliveryReply> {
	const reqId = crypto.randomUUID();
	const started = Date.now();
	const waiting = waitForReply<DeliveryReply>(reqId, 30_000);
	system.spawn(fake.definitions.delivery, {
		address: deliveryAddress(id),
		binding: {
			id,
			event,
			action,
			body,
			repoId,
			issueNumber,
			status: 'pending',
			responseCode: null,
			attempts: 0,
			lastAttemptAt: null,
			lastError: null,
			createdAt: nextId(),
			url: target?.url ?? null,
			secret: target?.secret ?? null,
			appId: target?.appId ?? null,
			installationId: target?.installationId ?? null,
			reqIds: [reqId],
			out: null
		}
	});
	const reply = await waiting;
	emitDelivery(reply, event, action, repoId, issueNumber);
	if (target) {
		const meta = deliveryMeta.get(reply.deliveryId);
		if (meta) Object.assign(meta, { appId: target.appId, installationId: target.installationId });
		await recordAppDelivery(target.appId, id, event, action, repoId, target.installationId, false, reply, started);
	}
	return reply;
}

/** ADR 0164: one entry in the app's delivery log per attempt. */
async function recordAppDelivery(
	appId: number,
	guid: string,
	event: string,
	action: string,
	repoId: number | null,
	installationId: number | null,
	redelivery: boolean,
	reply: DeliveryReply,
	started: number
) {
	await ask(system, APPS_ADDRESS, APPS_EVENTS.recordDelivery, {
		delivery: {
			id: nextId(),
			appId,
			guid,
			event,
			action: action || null,
			deliveredAt: Date.now(),
			redelivery,
			statusCode: reply.responseCode ?? 0,
			durationMs: Date.now() - started,
			installationId,
			repositoryId: repoId
		}
	});
}

/**
 * Deliver a repository event (ADR 0200): to every GitHub App installed on the
 * repo that subscribes to `event` (payload gains `installation`), else to the
 * default repo webhook (token mode). Returns the first delivery's reply.
 */
async function deliverRepoEvent(
	event: string,
	action: string,
	payload: Record<string, unknown>,
	repo: { id: number; owner: string; name: string },
	issueNumber: number | null
): Promise<DeliveryReply> {
	const covering = await ask<Covering[]>(system, APPS_ADDRESS, APPS_EVENTS.covering, {
		fullName: `${repo.owner}/${repo.name}`,
		owner: repo.owner,
		event
	});
	if (!covering.length) return deliver(action, JSON.stringify(payload), repo.id, issueNumber, event);
	let first: DeliveryReply | null = null;
	for (const { app, installation } of covering) {
		const body = JSON.stringify({ ...payload, installation: { id: installation.id, node_id: `MDIz_fake${installation.id}` } });
		const reply = await deliver(action, body, repo.id, issueNumber, event, crypto.randomUUID(), {
			url: app.webhookUrl,
			secret: app.webhookSecret,
			appId: app.id,
			installationId: installation.id
		});
		first ??= reply;
	}
	return first!;
}

/** Redeliver by guid (same body, same guid) and log it for its app. */
async function redeliverGuid(guid: string): Promise<DeliveryReply | null> {
	if (!system.findActor(deliveryAddress(guid))) return null;
	const started = Date.now();
	const result = await ask<DeliveryReply>(system, deliveryAddress(guid), DELIVERY_EVENTS.redeliver, {}, 30_000);
	const known = deliveryMeta.get(guid);
	emitDelivery(result, known?.event ?? 'issues', known?.action ?? '', known?.repoId ?? null, known?.number ?? null);
	if (known?.appId) {
		await recordAppDelivery(known.appId, guid, known.event, known.action, known.repoId, known.installationId ?? null, true, result, started);
	}
	return result;
}

const issueRef = (repo: { id: number; owner: string; name: string }, number: number) => ({
	repoId: repo.id,
	owner: repo.owner,
	repo: repo.name,
	number
});

const appRoutes = createAppRoutes({
	system,
	bases,
	ensureUser,
	ensureRepoId: async (owner, name) => (await ensureRepo(owner, name)).repo.id,
	repos: () => fake.snapshot().repos.map((r) => ({ fullName: r.fullName, id: r.id, owner: r.owner, name: r.name })),
	deliverTo: (target, event, action, body, repoId) => deliver(action, body, repoId, null, event, crypto.randomUUID(), target),
	redeliver: redeliverGuid,
	validate: <T,>(schema: unknown, value: unknown, what: string) => validate(schema as TSchema, value, what) as T,
	readJson,
	controlError: (status, error) => controlError(status, error),
	json,
	githubError
});

// ---------------------------------------------------------------------------
// /__control
// ---------------------------------------------------------------------------

async function control(req: Request, path: string): Promise<Response> {
	const method = req.method;
	if (method === 'GET' && path === CONTROL_PATHS.state) return json(fake.snapshot());
	if (method === 'GET' && path === CONTROL_PATHS.events) {
		const url = new URL(req.url);
		const since = Number(url.searchParams.get('since') ?? req.headers.get('last-event-id') ?? 0) || 0;
		return events.stream(since, req.signal);
	}
	if (method === 'GET' && path === CONTROL_PATHS.eventsLog) {
		const url = new URL(req.url);
		const since = Number(url.searchParams.get('since') ?? 0) || 0;
		const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 1000) || 1000, 1), 5000);
		return json({ events: events.since(since, limit), lastSeq: events.lastSeq } satisfies EventsLogResponse);
	}
	if (method !== 'POST') return controlError(405, `${method} ${path} not allowed`);

	if (path === CONTROL_PATHS.webhookOutage) {
		const body = validate(WebhookOutageRequest, await readJson(req), 'webhook outage');
		webhookOutage = body.down;
		return json({ ok: true });
	}

	if (path === CONTROL_PATHS.reset) {
		webhookOutage = false;
		fake.reset();
		return json({ ok: true });
	}

	if (path === CONTROL_PATHS.users) {
		const body = validate(EnsureUserRequest, await readJson(req), 'user');
		return json(await ensureUser(body.login, body.type));
	}

	if (path === CONTROL_PATHS.repos) {
		const body = validate(EnsureRepoRequest, await readJson(req), 'repo');
		const { repo } = await ensureRepo(body.owner, body.name);
		return json({ id: repo.id } satisfies EnsureRepoResponse);
	}

	if (path === CONTROL_PATHS.issues) {
		const body = validate(CreateIssueRequest, await readJson(req), 'issue');
		const { repo, owner } = await ensureRepo(body.owner, body.repo);
		const author = await ensureUser(body.author);
		const issue = unwrap<Issue>(
			await ask(system, repositoryAddress(repo.id), REPOSITORY_EVENTS.createIssue, {
				id: nextId(),
				author: userView(author, bases),
				title: body.title,
				body: body.body ?? '',
				association: body.association ?? 'NONE',
				now: now()
			}),
			controlError
		);
		events.emit({
			type: 'issue.opened',
			...issueRef(repo, issue.number),
			author: author.login,
			association: body.association ?? 'NONE',
			title: issue.title
		});
		const payload = issuesEvent('opened', issue, repositoryView(repo, owner, bases), userView(author, bases));
		const result = await deliverRepoEvent('issues', 'opened', payload as unknown as Record<string, unknown>, repo, issue.number);
		return json({ number: issue.number, deliveryId: result.deliveryId } satisfies CreateIssueResponse);
	}

	if (path === CONTROL_PATHS.reopen) {
		const body = validate(ReopenIssueRequest, await readJson(req), 'reopen request');
		const found = await findRepo(body.owner, body.repo);
		if (!found) return controlError(404, `Unknown repository ${body.owner}/${body.repo}`);
		const actor = await ensureUser(body.actor);
		const before = await ask<Issue | { error: string }>(system, repositoryAddress(found.repo.id), REPOSITORY_EVENTS.getIssue, {
			number: body.number
		});
		const issue = unwrap<Issue>(
			await ask(system, repositoryAddress(found.repo.id), REPOSITORY_EVENTS.reopenIssue, {
				number: body.number,
				now: now()
			}),
			(status) => controlError(status, `Unknown issue ${body.owner}/${body.repo}#${body.number}`)
		);
		if (!isFailure(before) && (before as Issue).state === 'closed') {
			events.emit({ type: 'issue.reopened', ...issueRef(found.repo, issue.number), by: actor.login });
		}
		const payload = issuesEvent(
			'reopened',
			issue,
			repositoryView(found.repo, found.owner, bases),
			userView(actor, bases)
		);
		const result = await deliverRepoEvent('issues', 'reopened', payload as unknown as Record<string, unknown>, found.repo, issue.number);
		return json({ deliveryId: result.deliveryId } satisfies ReopenIssueResponse);
	}

	const redeliver = /^\/__control\/deliveries\/([^/]+)\/redeliver$/.exec(path);
	if (redeliver) {
		await readJson(req, { allowEmpty: true }).catch(() => undefined);
		const id = decodeURIComponent(redeliver[1]!);
		const result = await redeliverGuid(id);
		if (!result) return controlError(404, `Unknown delivery ${id}`);
		return json({ deliveryId: result.deliveryId, responseCode: result.responseCode } satisfies RedeliverResponse);
	}

	if (path === CONTROL_PATHS.comment) {
		const body = validate(CreateCommentControlRequest, await readJson(req), 'comment');
		const found = await findRepo(body.owner, body.repo);
		if (!found) return controlError(404, `Unknown repository ${body.owner}/${body.repo}`);
		const author = await ensureUser(body.author);
		const comment = unwrap<IssueComment>(
			await ask(system, repositoryAddress(found.repo.id), REPOSITORY_EVENTS.createComment, {
				number: body.number,
				id: nextId(),
				user: userView(author, bases),
				body: body.body,
				now: now()
			}),
			(status) => controlError(status, `Unknown issue ${body.owner}/${body.repo}#${body.number}`)
		);
		events.emit({
			type: 'comment.created',
			...issueRef(found.repo, body.number),
			commentId: comment.id,
			author: author.login,
			body: body.body
		});
		const issue = unwrap<Issue>(
			await ask(system, repositoryAddress(found.repo.id), REPOSITORY_EVENTS.getIssue, { number: body.number }),
			controlError
		);
		const payload = {
			action: 'created',
			issue,
			comment,
			repository: repositoryView(found.repo, found.owner, bases),
			sender: userView(author, bases)
		};
		const result = await deliverRepoEvent('issue_comment', 'created', payload, found.repo, body.number);
		return json({ commentId: comment.id, deliveryId: result.deliveryId } satisfies CreateCommentControlResponse);
	}

	if (path === CONTROL_PATHS.rawDelivery) {
		const body = validate(RawDeliveryRequest, await readJson(req), 'raw delivery');
		const result = await deliver(
			body.action ?? '(raw)',
			body.body,
			null,
			null,
			body.event,
			body.deliveryId ?? crypto.randomUUID()
		);
		return json({ deliveryId: result.deliveryId, responseCode: result.responseCode } satisfies RawDeliveryResponse);
	}

	if (path === CONTROL_PATHS.faults) {
		const body = validate(InjectFaultRequest, await readJson(req), 'fault');
		try {
			new RegExp(body.pathPattern);
		} catch (e) {
			return controlError(400, `Invalid fault`, [{ message: (e as Error).message, path: ['pathPattern'] }]);
		}
		const id = `fault-${nextId()}`;
		const result = await ask<InjectFaultResponse>(system, FAULTS_ADDRESS, FAULT_EVENTS.inject, { ...body, id });
		return json(result);
	}

	return controlError(404, `Unknown control endpoint ${path}`);
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

async function authorize(url: URL): Promise<Response> {
	const query = Object.fromEntries(url.searchParams);
	const issues = issuesOf(OAuthAuthorizeQuery, query);
	if (issues.length) {
		return new Response(`Invalid authorize request: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, {
			status: 400
		});
	}
	const q = query as Static<typeof OAuthAuthorizeQuery>;
	const appClient = await appRoutes.findApp({ clientId: q.client_id });
	if (!appClient && oauthClientId && q.client_id !== oauthClientId) {
		return new Response(`Unknown client_id ${q.client_id}`, { status: 400 });
	}
	if (!q.redirect_uri) return new Response('redirect_uri is required by the fake', { status: 400 });
	if (!q.login) {
		const users = fake.snapshot().users;
		return new Response(authorizePage(url, users), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	}
	const user = await ensureUser(q.login);
	const code = crypto.randomUUID().replaceAll('-', '');
	await ask(system, OAUTH_ADDRESS, OAUTH_EVENTS.authorize, {
		code,
		login: user.login,
		clientId: q.client_id,
		redirectUri: q.redirect_uri,
		now: Date.now()
	});
	const target = new URL(q.redirect_uri);
	target.searchParams.set('code', code);
	target.searchParams.set('state', q.state);
	return new Response(null, { status: 302, headers: { Location: target.toString() } });
}

async function accessToken(req: Request, url: URL): Promise<Response> {
	const type = req.headers.get('content-type') ?? '';
	let body: Record<string, unknown> = Object.fromEntries(url.searchParams);
	const text = await req.text();
	if (text.trim()) {
		if (type.includes('application/json')) {
			try {
				body = { ...body, ...(JSON.parse(text) as Record<string, unknown>) };
			} catch {
				return json({ error: 'invalid_request', error_description: 'Malformed JSON' }, 400);
			}
		} else {
			body = { ...body, ...Object.fromEntries(new URLSearchParams(text)) };
		}
	}
	const issues = issuesOf(OAuthAccessTokenRequest, body);
	const wantsJson = (req.headers.get('accept') ?? '').includes('json');
	const respond = (payload: Record<string, string>) =>
		wantsJson
			? json(payload)
			: new Response(new URLSearchParams(payload).toString(), {
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
				});
	if (issues.length) {
		return respond({ error: 'invalid_request', error_description: issues.map((i) => i.message).join('; ') });
	}
	const b = body as Static<typeof OAuthAccessTokenRequest>;
	// ADR 0164: a GitHub App's client id/secret work too (user-to-server tokens, `ghu_`).
	const appClient = await appRoutes.findApp({ clientId: b.client_id });
	const badClient = appClient
		? b.client_secret !== appClient.clientSecret
		: (oauthClientId && b.client_id !== oauthClientId) || (oauthClientSecret && b.client_secret !== oauthClientSecret);
	if (badClient) {
		return respond({
			error: 'incorrect_client_credentials',
			error_description: 'The client_id and/or client_secret passed are incorrect.'
		});
	}
	const result = await ask<Record<string, string>>(system, OAUTH_ADDRESS, OAUTH_EVENTS.exchange, {
		code: b.code,
		clientId: b.client_id,
		token: `${appClient ? 'ghu' : 'gho'}_fake${crypto.randomUUID().replaceAll('-', '')}`,
		now: Date.now()
	});
	return respond(result);
}

function bearer(req: Request): string | null {
	const h = req.headers.get('authorization') ?? '';
	const m = /^(?:bearer|token)\s+(\S+)\s*$/i.exec(h);
	return m ? m[1]! : null;
}

/** ADR 0164: the installation behind a `ghs_` token (null when unknown or expired). */
async function installationOf(token: string): Promise<{ installation: InstallationRecord; app: AppRecord } | null> {
	if (!token.startsWith('ghs_')) return null;
	return ask(system, APPS_ADDRESS, APPS_EVENTS.resolveToken, { token, now: Date.now() });
}

/**
 * The user a token acts as: an OAuth token's user, an installation token's
 * `<slug>[bot]`, else (any other token, token mode) the app bot.
 */
async function tokenUser(token: string): Promise<FakeUser> {
	const login = await ask<string | null>(system, OAUTH_ADDRESS, OAUTH_EVENTS.whoami, { token });
	if (login) return (await getUser(login)) ?? (await ensureUser(login));
	const inst = await installationOf(token);
	if (inst) return ensureUser(`${inst.app.slug}[bot]`, 'Bot');
	return ensureUser(BOT_LOGIN, 'Bot');
}

async function currentUser(req: Request): Promise<Response> {
	const token = bearer(req);
	if (!token) return githubError(401, 'Requires authentication');
	if (token.startsWith('ghs_')) return githubError(403, 'Resource not accessible by integration');
	const u = await tokenUser(token);
	const view: AuthenticatedUser & Record<string, unknown> = { ...userView(u, bases), avatar_url: u.avatarUrl, name: u.login };
	return json(view);
}

// ---------------------------------------------------------------------------
// REST (GitHub-compatible subset)
// ---------------------------------------------------------------------------

const ISSUE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/comments)?\/?$/;

async function rest(req: Request, path: string, m: RegExpExecArray): Promise<Response> {
	const token = bearer(req);
	if (!token) return githubError(401, 'Requires authentication');
	// ADR 0164: installation tokens must be valid and cover the repository.
	let installation: InstallationRecord | null = null;
	if (token.startsWith('ghs_')) {
		const inst = await installationOf(token);
		if (!inst) return githubError(401, 'Bad credentials');
		installation = inst.installation;
	} else if (token.startsWith('eyJ')) {
		return githubError(401, 'A JSON web token could not be used to access this resource');
	}

	const fault = await ask<FaultHit | null>(system, FAULTS_ADDRESS, FAULT_EVENTS.check, { method: req.method, path });
	if (fault) {
		const headers: Record<string, string> = {};
		if (fault.retryAfter !== undefined) headers['Retry-After'] = String(fault.retryAfter);
		return json({ message: 'injected fault' }, fault.status, headers);
	}

	const [, owner, repoName, numberText, comments] = m;
	const number = Number(numberText);
	const found = await findRepo(owner!, repoName!);
	if (!found) return githubError(404, 'Not Found');
	if (installation && !repoCovered(installation, found.repo.fullName, found.repo.owner)) return githubError(404, 'Not Found');
	const address = repositoryAddress(found.repo.id);
	const notFound = (status: number, msg: string) => githubError(status, msg);

	if (!comments && req.method === 'GET') {
		return json(unwrap(await ask(system, address, REPOSITORY_EVENTS.getIssue, { number }), notFound));
	}
	if (!comments && req.method === 'PATCH') {
		let body: unknown;
		try {
			body = JSON.parse(await req.text());
		} catch {
			return githubError(400, 'Problems parsing JSON');
		}
		const issues = issuesOf(UpdateIssueRequest, body);
		if (issues.length) return json({ message: 'Validation Failed', errors: issues }, 422);
		const before = await ask<Issue | { error: string }>(system, address, REPOSITORY_EVENTS.getIssue, { number });
		const after = unwrap<Issue>(
			await ask(system, address, REPOSITORY_EVENTS.updateIssue, { number, patch: body, now: now() }),
			notFound
		);
		if (!isFailure(before)) {
			const prev = (before as Issue).state;
			if (prev !== after.state) {
				const by = (await tokenUser(token)).login;
				if (after.state === 'closed') {
					events.emit({
						type: 'issue.closed',
						...issueRef(found.repo, number),
						by,
						stateReason: after.state_reason ?? null
					});
				} else {
					events.emit({ type: 'issue.reopened', ...issueRef(found.repo, number), by });
				}
			}
		}
		return json(after);
	}
	if (comments && req.method === 'GET') {
		return json(unwrap(await ask(system, address, REPOSITORY_EVENTS.listComments, { number }), notFound));
	}
	if (comments && req.method === 'POST') {
		let body: unknown;
		try {
			body = JSON.parse(await req.text());
		} catch {
			return githubError(400, 'Problems parsing JSON');
		}
		const issues = issuesOf(CreateCommentRequest, body);
		if (issues.length) return json({ message: 'Validation Failed', errors: issues }, 422);
		const user: GitHubUser = userView(await tokenUser(token), bases);
		const comment = unwrap<IssueComment>(
			await ask(system, address, REPOSITORY_EVENTS.createComment, {
				number,
				id: nextId(),
				user,
				body: (body as { body: string }).body,
				now: now()
			}),
			notFound
		);
		events.emit({
			type: 'comment.created',
			...issueRef(found.repo, number),
			commentId: comment.id,
			author: user.login,
			body: comment.body ?? ''
		});
		return json(comment, 201);
	}
	return githubError(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	if (path === '/' && req.method === 'GET') {
		return new Response(controlPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	}
	if (path === '/healthz') return json({ ok: true });
	const appResponse = await appRoutes.route(req, url);
	if (appResponse) return appResponse;
	if (path.startsWith('/__control/')) return control(req, path);
	if (path === '/installation/repositories' && req.method === 'GET') {
		const token = bearer(req);
		const inst = token ? await installationOf(token) : null;
		if (!inst) return githubError(401, 'Bad credentials');
		return appRoutes.installationRepos(inst.installation);
	}
	if (path === '/login/oauth/authorize' && req.method === 'GET') return authorize(url);
	if (path === '/login/oauth/access_token' && req.method === 'POST') return accessToken(req, url);
	if (path === '/user' && req.method === 'GET') return currentUser(req);
	const m = ISSUE_PATH.exec(path);
	if (m) return rest(req, path, m);
	return githubError(404, 'Not Found');
}

const server = Bun.serve({
	port,
	idleTimeout: 60,
	async fetch(req) {
		try {
			return await route(req);
		} catch (e) {
			if (e instanceof HttpError) return e.response;
			console.error('[fake-github]', req.method, req.url, e);
			return json({ error: (e as Error).message }, 500);
		}
	}
});

console.log(`[fake-github] listening on ${server.url} (public ${base}); webhooks → ${webhookUrl()}`);

const shutdown = () => {
	server.stop(true);
	system.close();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
