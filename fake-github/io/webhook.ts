/**
 * The `webhook` I/O processor (ADR 0060): POSTs a delivery's exact body to
 * FAKE_GITHUB_WEBHOOK_URL with GitHub's headers and an HMAC-SHA256 signature
 * over the body bytes, then posts `webhook.result {responseCode, error}`
 * back to the delivery actor. `responseCode` is null when unreachable.
 */
import type { IOProcessor } from '@tinyactors/node';

export const WEBHOOK_IO = 'webhook';
export const WEBHOOK_RESULT = 'webhook.result';

/** Data of `<send event="webhook.post" type="webhook">`. */
export interface WebhookPost {
	deliveryId: string;
	event: string;
	body: string;
	/** ADR 0200: per-delivery target (GitHub App hook); null/absent = config default. */
	url?: string | null;
	secret?: string | null;
	/** Set for GitHub App deliveries (adds the installation-target headers). */
	appId?: number | null;
}

export interface WebhookResult {
	responseCode: number | null;
	error: string | null;
	at: number;
}

export interface WebhookConfig {
	url: () => string;
	secret: () => string;
	timeoutMs?: number;
	/** ADR 0200: while true, deliveries fail without connecting (`status_code` 0). */
	outage?: () => boolean;
}

export function signature(secret: string, body: string): string {
	const hmac = new Bun.CryptoHasher('sha256', secret);
	hmac.update(body);
	return `sha256=${hmac.digest('hex')}`;
}

export function webhookProcessor(config: WebhookConfig): IOProcessor {
	return {
		async send(request, context) {
			const post = request.data as WebhookPost;
			let result: WebhookResult;
			if (config.outage?.()) {
				result = { responseCode: null, error: 'webhook outage (simulated)', at: Date.now() };
				if (!context.system.closed) context.post(request.source, WEBHOOK_RESULT, result);
				return;
			}
			try {
				const res = await fetch(post.url ?? config.url(), {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'User-Agent': 'GitHub-Hookshot/fake',
						'X-GitHub-Event': post.event,
						'X-GitHub-Delivery': post.deliveryId,
						'X-GitHub-Hook-ID': post.appId ? String(post.appId) : '1',
						...(post.appId
							? { 'X-GitHub-Hook-Installation-Target-Type': 'integration', 'X-GitHub-Hook-Installation-Target-ID': String(post.appId) }
							: { 'X-GitHub-Hook-Installation-Target-Type': 'repository' }),
						'X-Hub-Signature-256': signature(post.secret ?? config.secret(), post.body)
					},
					body: post.body,
					signal: AbortSignal.any([context.signal, AbortSignal.timeout(config.timeoutMs ?? 10_000)])
				});
				await res.arrayBuffer().catch(() => undefined);
				result = { responseCode: res.status, error: null, at: Date.now() };
			} catch (e) {
				result = { responseCode: null, error: (e as Error).message, at: Date.now() };
			}
			if (!context.system.closed) context.post(request.source, WEBHOOK_RESULT, result);
		}
	};
}
