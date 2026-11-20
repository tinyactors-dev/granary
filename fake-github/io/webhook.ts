/**
 * The `webhook` I/O processor (ADR 0060, 0230): POSTs a delivery's exact body
 * to its GitHub App's hook URL with GitHub's headers and an HMAC-SHA256 signature
 * over the body bytes, then answers the delivery actor with
 * `webhook.result {responseCode, error, at}`. `responseCode` is null when
 * unreachable.
 */
import type { IOProcessor } from '@tinyactors/node';

export const WEBHOOK_IO = 'webhook';
export const WEBHOOK_POST = 'webhook.post';
export const WEBHOOK_RESULT = 'webhook.result';

/** Data of `<send event="webhook.post" type="webhook">`. */
export interface WebhookPost {
	deliveryId: string;
	event: string;
	body: string;
	/** The GitHub App's hook URL and secret (ADR 0200). */
	url: string;
	secret: string;
	appId: number;
}

export interface WebhookResult {
	responseCode: number | null;
	error: string | null;
	at: number;
}

export interface WebhookConfig {
	timeoutMs?: number;
	/** ADR 0200: while true, deliveries fail without connecting (`status_code` 0). */
	outage?: () => boolean;
	/** Aborted at shutdown: requests in flight stop and nothing is answered. */
	signal?: AbortSignal;
}

export function signature(secret: string, body: string): string {
	const hmac = new Bun.CryptoHasher('sha256', secret);
	hmac.update(body);
	return `sha256=${hmac.digest('hex')}`;
}

async function post(p: WebhookPost, config: WebhookConfig): Promise<WebhookResult> {
	if (config.outage?.()) return { responseCode: null, error: 'webhook outage (simulated)', at: Date.now() };
	const signals = [AbortSignal.timeout(config.timeoutMs ?? 10_000), ...(config.signal ? [config.signal] : [])];
	try {
		const res = await fetch(p.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': 'GitHub-Hookshot/fake',
				'X-GitHub-Event': p.event,
				'X-GitHub-Delivery': p.deliveryId,
				'X-GitHub-Hook-ID': String(p.appId),
				'X-GitHub-Hook-Installation-Target-Type': 'integration',
				'X-GitHub-Hook-Installation-Target-ID': String(p.appId),
				'X-Hub-Signature-256': signature(p.secret, p.body)
			},
			body: p.body,
			signal: AbortSignal.any(signals)
		});
		await res.arrayBuffer().catch(() => undefined);
		return { responseCode: res.status, error: null, at: Date.now() };
	} catch (e) {
		return { responseCode: null, error: (e as Error).message, at: Date.now() };
	}
}

export function webhookProcessor(config: WebhookConfig): IOProcessor {
	return {
		async receive(send) {
			const result = await post(send.data as unknown as WebhookPost, config);
			if (config.signal?.aborted) return;
			try {
				send.answer(WEBHOOK_RESULT, { ...result });
			} catch {
				// The host closed meanwhile (reset or shutdown): nobody to tell.
			}
		}
	};
}
