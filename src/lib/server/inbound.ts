/**
 * Inbound webhooks (ADR 0003): signature check, parsing, the inbox row, and
 * turning an `issues.opened` inbox row into `issue.opened` event data.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { issueKey, type IssueOpenedData } from '../schemas/actors';
import { AuthorAssociation, parseIssuesWebhook, type IssuesWebhookPayload } from '../schemas/github';
import { check } from '../schemas/standard';
import type { InboxRow } from '../schemas/wal';

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
