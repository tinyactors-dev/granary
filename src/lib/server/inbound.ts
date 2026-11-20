/**
 * Inbound webhooks (ADR 0003, ADR 0160, ADR 0192): signature check against
 * the connection's secret (503 while GitHub is not connected), parsing, the
 * per-repo policy, installation sync events, the inbox row, and turning an
 * `issues.opened` inbox row into `issue.opened` event data.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { issueKey, type IssueOpenedData } from '../schemas/actors';
import {
	AuthorAssociation,
	WEBHOOK_HEADERS,
	parseIssuesWebhook,
	parsePullRequestWebhook,
	parseDiscussionWebhook,
	type DiscussionWebhookPayload,
	type IssuesWebhookPayload,
	type PullRequestWebhookPayload
} from '../schemas/github';
import { GITHUB_APP_LIFECYCLE_EVENTS } from '../schemas/github-app';
import { SchemaValidationError, check } from '../schemas/standard';
import type { InboxRow } from '../schemas/wal';
import { installationIdOf } from './github/webhooks';
import { currentLogContext, log, traceparentFor } from './log';
import type { Runtime } from './system';
import { introductionScope, isIntroductionsCategory } from './introductions';
import type { Wal } from './wal';

/** Constant-time check of `X-Hub-Signature-256: sha256=<hex hmac>`. */
export function verifySignature(secret: string, body: Uint8Array, header: string | null): boolean {
	if (!header || !header.startsWith('sha256=')) return false;
	const given = header.slice('sha256='.length).trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(given)) return false;
	const expected = createHmac('sha256', secret).update(body).digest();
	return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

export function signBody(secret: string, body: string | Uint8Array): string {
	return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** `issue.opened` data for a parsed `issues` payload. */
export function issueOpenedData(deliveryId: string, p: IssuesWebhookPayload): IssueOpenedData {
	return {
		deliveryId,
		issueKey: issueKey(p.repository.id, p.issue.number),
		repoId: p.repository.id,
		owner: p.repository.owner.login,
		repo: p.repository.name,
		number: p.issue.number,
		author: p.issue.user.login,
		authorType: p.issue.user.type,
		association: check(AuthorAssociation, p.issue.author_association) ? p.issue.author_association : 'NONE',
		title: p.issue.title,
		htmlUrl: p.issue.html_url
	};
}

/** `issue.opened` data (kind `pull_request`) for a parsed `pull_request` payload (ADR 0280). */
export function pullRequestOpenedData(deliveryId: string, p: PullRequestWebhookPayload): IssueOpenedData {
	const pr = p.pull_request;
	return {
		deliveryId,
		issueKey: issueKey(p.repository.id, pr.number),
		kind: 'pull_request',
		repoId: p.repository.id,
		owner: p.repository.owner.login,
		repo: p.repository.name,
		number: pr.number,
		author: pr.user.login,
		authorType: pr.user.type,
		association: check(AuthorAssociation, pr.author_association) ? pr.author_association : 'NONE',
		title: pr.title,
		htmlUrl: pr.html_url
	};
}

/** `issue.opened` data from a stored `issues.opened` / `pull_request.opened` inbox row, or null if it does not parse. */
export function issueOpenedFromInbox(row: InboxRow): IssueOpenedData | null {
	if (row.action !== 'opened') return null;
	try {
		if (row.event === 'issues') return issueOpenedData(row.delivery_id, parseIssuesWebhook(row.payload));
		if (row.event === 'pull_request') return pullRequestOpenedData(row.delivery_id, parsePullRequestWebhook(row.payload));
		return null;
	} catch {
		return null;
	}
}

export interface WebhookResult {
	status: number;
	/** JSON body for 2xx, plain text otherwise. */
	body: Record<string, unknown> | string;
}

const LIFECYCLE = new Set<string>(GITHUB_APP_LIFECYCLE_EVENTS);

/** `discussion` actions that matter to introductions (ADR 0310). */
const DISCUSSION_ACTIONS = new Set(['created', 'edited', 'deleted', 'category_changed']);

/**
 * What a `discussion` delivery does to introductions (ADR 0310), decided
 * before the inbox row is written; `apply` runs in the same transaction.
 */
export function discussionDecision(
	wal: Wal,
	p: DiscussionWebhookPayload,
	deliveryId: string,
	guarded: boolean
): { reason: string | null; apply: () => string } {
	const d = p.discussion;
	const owner = p.repository.owner.login;
	const repo = p.repository.name;
	const key = issueKey(p.repository.id, d.number);
	const ignore = (reason: string) => ({ reason, apply: () => reason });
	const scope = introductionScope(wal.db, owner, repo, guarded);
	if (!scope) return ignore(`${owner}/${repo} is not gated, and not ${owner}'s org discussions repository`);
	if (!DISCUSSION_ACTIONS.has(p.action)) return ignore(`discussion.${p.action} is not acted on`);
	const inCategory = isIntroductionsCategory(d.category);
	const existing = wal.getIntroduction(key);
	const record = () => {
		const { created } = wal.upsertIntroduction({
			introKey: key,
			repoId: p.repository.id,
			owner,
			repo,
			number: d.number,
			nodeId: d.node_id,
			author: d.user.login,
			association: d.author_association ?? null,
			title: d.title,
			body: d.body ?? '',
			htmlUrl: d.html_url,
			scope,
			deliveryId
		});
		return created ? `introduction ${key} received` : `introduction ${key} updated`;
	};
	if (p.action === 'deleted') {
		if (!existing) return ignore('not an introduction');
		return { reason: null, apply: () => (wal.withdrawIntroduction(key) ? `introduction ${key} withdrawn (deleted)` : `introduction ${key} deleted (already ${existing.state})`) };
	}
	if (p.action === 'category_changed' && !inCategory) {
		if (!existing) return ignore('not in the Introductions category');
		return { reason: null, apply: () => (wal.withdrawIntroduction(key) ? `introduction ${key} withdrawn (moved out)` : `introduction ${key} moved out (already ${existing.state})`) };
	}
	if (!inCategory) return ignore('not in the Introductions category');
	if (p.action === 'edited' && existing) return { reason: null, apply: () => (wal.updateIntroductionText(key, d.title, d.body ?? ''), `introduction ${key} edited`) };
	return { reason: null, apply: record };
}

/**
 * `POST /webhook` (ADR 0003, 0160, 0192):
 * 1. no connection / no secret (setup required) → 503;
 * 2. bad `X-Hub-Signature-256` → 401; missing headers or bad JSON → 400;
 * 3. installation lifecycle events sync installations/repos (app mode);
 * 4. `issues` of a disabled or unknown repo → stored `ignored` with a reason;
 * 5. `INSERT OR IGNORE` the inbox row (committed), 202 (also for duplicates),
 *    and for a new `issues.opened` row post `issue.opened`;
 * 6. `discussion` in an Introductions category records the introduction in
 *    the same transaction (ADR 0310).
 */
export async function handleWebhook(rt: Runtime, request: Request): Promise<WebhookResult> {
	const secret = await rt.github.webhookSecret();
	if (!secret) return { status: 503, body: 'GitHub is not connected yet (setup required)' };

	const body = new Uint8Array(await request.arrayBuffer());
	if (!verifySignature(secret, body, request.headers.get(WEBHOOK_HEADERS.signature256))) {
		log.warn('webhook: rejected, invalid signature', { 'github.event': request.headers.get(WEBHOOK_HEADERS.event) ?? undefined, 'github.delivery_id': request.headers.get(WEBHOOK_HEADERS.delivery) ?? undefined });
		return { status: 401, body: 'Invalid signature' };
	}

	const event = request.headers.get(WEBHOOK_HEADERS.event);
	const deliveryId = request.headers.get(WEBHOOK_HEADERS.delivery);
	if (!event || !deliveryId || deliveryId.length > 200) {
		return { status: 400, body: 'Missing X-GitHub-Event or X-GitHub-Delivery' };
	}

	let raw: string;
	try {
		raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
	} catch {
		return { status: 400, body: 'Body is not UTF-8' };
	}

	let payload: IssuesWebhookPayload | null = null;
	let prPayload: PullRequestWebhookPayload | null = null;
	let discPayload: DiscussionWebhookPayload | null = null;
	let json: unknown = null;
	let action: string | null = null;
	let key: string | null = null;
	try {
		json = JSON.parse(raw);
		if (event === 'issues') {
			payload = parseIssuesWebhook(raw);
			action = payload.action;
			key = issueKey(payload.repository.id, payload.issue.number);
		} else if (event === 'pull_request') {
			prPayload = parsePullRequestWebhook(raw);
			action = prPayload.action;
			key = issueKey(prPayload.repository.id, prPayload.pull_request.number);
		} else if (event === 'discussion') {
			discPayload = parseDiscussionWebhook(raw);
			action = discPayload.action;
		} else {
			const a = (json as { action?: unknown } | null)?.action;
			action = typeof a === 'string' ? a : null;
		}
	} catch (e) {
		return { status: 400, body: e instanceof SchemaValidationError ? e.message : 'Malformed JSON' };
	}

	// Duplicate deliveries (redelivery, catch-up) must not re-apply side effects.
	const duplicate = rt.wal.getInbox(deliveryId) !== null;

	let note: string | null = null;
	if (LIFECYCLE.has(event) && rt.github.mode() === 'app' && !duplicate) {
		note = rt.github.applyLifecycleEvent(event, json);
		log.info(`webhook: ${note}`, { 'github.event': event, 'github.action': action ?? undefined, 'github.delivery_id': deliveryId });
	}

	let reason: string | null = null;
	if (payload) {
		const policy = rt.github.repoPolicy(payload.repository.id, payload.repository.full_name, installationIdOf(json));
		if (!policy.guarded) reason = policy.reason;
	} else if (prPayload && action === 'opened') {
		// Only `opened` is gated, drafts included (ADR 0280); the policy is per kind.
		const policy = rt.github.repoPolicy(prPayload.repository.id, prPayload.repository.full_name, installationIdOf(json), 'pull_requests');
		if (!policy.guarded) reason = policy.reason;
	}

	// Introductions (ADR 0310): recorded here, in the inbox row's transaction.
	let discussion: ReturnType<typeof discussionDecision> | null = null;
	if (discPayload) {
		const policy = rt.github.repoPolicy(discPayload.repository.id, discPayload.repository.full_name, installationIdOf(json));
		discussion = discussionDecision(rt.wal, discPayload, deliveryId, policy.guarded);
		reason = discussion.reason;
	}

	const actionable = (event === 'issues' || event === 'pull_request') && action === 'opened' && reason === null;
	const applied = discussion !== null && discussion.reason === null;
	const state = actionable ? 'pending' : applied ? 'done' : 'ignored';
	let inserted: boolean;
	try {
		const ignoreReason = actionable || applied ? null : (reason ?? `${action ? `${event}.${action}` : event} is not acted on`);
		inserted = rt.wal.tx(() => {
			const fresh = rt.wal.insertInbox({ deliveryId, event, action, issueKey: key, payload: raw, state, ignoreReason });
			if (fresh && applied) note = discussion!.apply();
			return fresh;
		});
	} catch (e) {
		log.error(`webhook: could not store delivery ${deliveryId}`, e);
		return { status: 500, body: 'Could not store delivery' };
	}
	const outcome = !inserted ? 'duplicate' : actionable || applied ? 'accepted' : 'ignored';
	const ignoreReason = actionable || applied ? undefined : (reason ?? `${action ? `${event}.${action}` : event} is not acted on`);
	log.info(`webhook: ${event}${action ? `.${action}` : ''} ${outcome}${outcome === 'ignored' && ignoreReason ? ` (${ignoreReason})` : ''}`, {
		'github.event': event,
		'github.action': action ?? undefined,
		'github.delivery_id': deliveryId,
		'github.repository': payload?.repository.full_name ?? prPayload?.repository.full_name,
		'github.issue.number': payload?.issue.number ?? prPayload?.pull_request.number,
		'github.issue.author': payload?.issue.user.login ?? prPayload?.pull_request.user.login,
		'granary.issue_key': key ?? undefined,
		'webhook.outcome': outcome,
		'webhook.reason': outcome === 'ignored' ? ignoreReason : undefined
	});

	if (inserted && actionable && payload) rt.postIssueOpened(issueOpenedData(deliveryId, payload), traceparentFor(currentLogContext()));
	if (inserted && actionable && prPayload) rt.postIssueOpened(pullRequestOpenedData(deliveryId, prPayload), traceparentFor(currentLogContext()));
	// A discussion shows Discussions are on there: check the repository again (its category may be new).
	if (inserted && discPayload && (applied || /Introductions category/.test(reason ?? ''))) {
		rt.introductions.check(discPayload.repository.owner.login, discPayload.repository.name).catch((e) => log.warn('introductions: setup check failed', e));
	}

	return { status: 202, body: { deliveryId, state, duplicate: !inserted, ...(reason ? { reason } : {}), ...(note ? { note } : {}) } };
}
