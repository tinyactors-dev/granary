/**
 * `POST /webhook` — GitHub webhooks (ADR 0003).
 *
 * 1. verify `X-Hub-Signature-256` (constant time) → 401;
 * 2. require `X-GitHub-Event` / `X-GitHub-Delivery`, parse `issues` bodies
 *    with TypeBox → 400;
 * 3. `INSERT OR IGNORE` the inbox row (committed) — `issues.opened` as
 *    `pending`, everything else `ignored`;
 * 4. 202 (also for a duplicate delivery id), and for a new `issues.opened`
 *    row post `issue.opened` to `issue/<repoId>-<number>`.
 */
import { json, text, type RequestHandler } from '@sveltejs/kit';
import { issueKey } from '$lib/schemas/actors';
import { WEBHOOK_HEADERS, parseIssuesWebhook, type IssuesWebhookPayload } from '$lib/schemas/github';
import { SchemaValidationError } from '$lib/schemas/standard';
import { issueOpenedData, verifySignature } from '$lib/server/inbound';
import { log } from '$lib/server/log';
import { getRuntime } from '$lib/server/system';

export const POST: RequestHandler = async ({ request }) => {
	const rt = getRuntime();
	if (!rt || rt.closed) return text('Service Unavailable', { status: 503 });

	const body = new Uint8Array(await request.arrayBuffer());
	if (!verifySignature(rt.config.webhookSecret, body, request.headers.get(WEBHOOK_HEADERS.signature256))) {
		return text('Invalid signature', { status: 401 });
	}

	const event = request.headers.get(WEBHOOK_HEADERS.event);
	const deliveryId = request.headers.get(WEBHOOK_HEADERS.delivery);
	if (!event || !deliveryId || deliveryId.length > 200) {
		return text('Missing X-GitHub-Event or X-GitHub-Delivery', { status: 400 });
	}

	let raw: string;
	try {
		raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
	} catch {
		return text('Body is not UTF-8', { status: 400 });
	}

	let payload: IssuesWebhookPayload | null = null;
	let action: string | null = null;
	let key: string | null = null;
	try {
		if (event === 'issues') {
			payload = parseIssuesWebhook(raw);
			action = payload.action;
			key = issueKey(payload.repository.id, payload.issue.number);
		} else {
			const parsed = JSON.parse(raw) as { action?: unknown };
			action = typeof parsed?.action === 'string' ? parsed.action : null;
		}
	} catch (e) {
		const message = e instanceof SchemaValidationError ? e.message : 'Malformed JSON';
		return text(message, { status: 400 });
	}

	const actionable = event === 'issues' && action === 'opened';
	const state = actionable ? 'pending' : 'ignored';
	let inserted: boolean;
	try {
		inserted = rt.wal.insertInbox({ deliveryId, event, action, issueKey: key, payload: raw, state });
	} catch (e) {
		log.error(`webhook: could not store delivery ${deliveryId}`, e);
		return text('Could not store delivery', { status: 500 });
	}

	if (inserted && actionable && payload) rt.postIssueOpened(issueOpenedData(deliveryId, payload));

	return json({ deliveryId, state, duplicate: !inserted }, { status: 202 });
};
