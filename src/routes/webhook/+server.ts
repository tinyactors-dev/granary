/**
 * `POST /webhook` — GitHub webhooks (ADR 0003, ADR 0160, ADR 0192). The
 * logic lives in `handleWebhook` (`$lib/server/inbound`): 503 while GitHub
 * is not connected, 401 bad signature, 400 malformed, else 202 after the
 * inbox row is committed.
 */
import { json, text, type RequestHandler } from '@sveltejs/kit';
import { handleWebhook } from '$lib/server/inbound';
import { getRuntime } from '$lib/server/system';

export const POST: RequestHandler = async ({ request }) => {
	const rt = getRuntime();
	if (!rt || rt.closed) return text('Service Unavailable', { status: 503 });
	const result = await handleWebhook(rt, request);
	return typeof result.body === 'string' ? text(result.body, { status: result.status }) : json(result.body, { status: result.status });
};
