/**
 * Inbound webhooks (ADR 0003, ADR 0160, ADR 0192): signature check against
 * the connection's secret (503 while GitHub is not connected), parsing, the
 * per-repo policy, installation sync events, the inbox row, and turning an
 * `issues.opened` inbox row into `issue.opened` event data.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { issueKey, type IssueOpenedData } from '../schemas/actors';
import { AuthorAssociation, WEBHOOK_HEADERS, parseIssuesWebhook, type IssuesWebhookPayload } from '../schemas/github';
import { GITHUB_APP_LIFECYCLE_EVENTS } from '../schemas/github-app';
import { SchemaValidationError, check } from '../schemas/standard';
import type { InboxRow } from '../schemas/wal';
import { installationIdOf } from './github/webhooks';
import { log } from './log';
import type { Runtime } from './system';

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

/** `issue.opened` data from a stored `issues`/`opened` inbox row, or null if it does not parse. */
export function issueOpenedFromInbox(row: InboxRow): IssueOpenedData | null {
	if (row.event !== 'issues' || row.action !== 'opened') return null;
	try {
		return issueOpenedData(row.delivery_id, parseIssuesWebhook(row.payload));
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

/**
 * `POST /webhook` (ADR 0003, 0160, 0192):
 * 1. no connection / no secret (setup required) → 503;
 * 2. bad `X-Hub-Signature-256` → 401; missing headers or bad JSON → 400;
 * 3. installation lifecycle events sync installations/repos (app mode);
 * 4. `issues` of a disabled or unknown repo → stored `ignored` with a reason;
 * 5. `INSERT OR IGNORE` the inbox row (committed), 202 (also for duplicates),
 *    and for a new `issues.opened` row post `issue.opened`.
 */
export async function handleWebhook(rt: Runtime, request: Request): Promise<WebhookResult> {
	const secret = await rt.github.webhookSecret();
	if (!secret) return { status: 503, body: 'GitHub is not connected yet (setup required)' };

	const body = new Uint8Array(await request.arrayBuffer());
	if (!verifySignature(secret, body, request.headers.get(WEBHOOK_HEADERS.signature256))) {
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
	let json: unknown = null;
	let action: string | null = null;
	let key: string | null = null;
	try {
		json = JSON.parse(raw);
		if (event === 'issues') {
			payload = parseIssuesWebhook(raw);
			action = payload.action;
			key = issueKey(payload.repository.id, payload.issue.number);
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
		log.info(`webhook: ${note}`);
	}

	let reason: string | null = null;
	if (payload) {
		const policy = rt.github.repoPolicy(payload.repository.id, payload.repository.full_name, installationIdOf(json));
		if (!policy.guarded) reason = policy.reason;
	}

	const actionable = event === 'issues' && action === 'opened' && reason === null;
	const state = actionable ? 'pending' : 'ignored';
	let inserted: boolean;
	try {
		const ignoreReason = actionable ? null : (reason ?? `${action ? `${event}.${action}` : event} is not acted on`);
		inserted = rt.wal.insertInbox({ deliveryId, event, action, issueKey: key, payload: raw, state, ignoreReason });
	} catch (e) {
		log.error(`webhook: could not store delivery ${deliveryId}`, e);
		return { status: 500, body: 'Could not store delivery' };
	}
	if (inserted && reason) log.info(`webhook: ${deliveryId} (${event}.${action}) ignored: ${reason}`);

	if (inserted && actionable && payload) rt.postIssueOpened(issueOpenedData(deliveryId, payload));

	return { status: 202, body: { deliveryId, state, duplicate: !inserted, ...(reason ? { reason } : {}), ...(note ? { note } : {}) } };
}
