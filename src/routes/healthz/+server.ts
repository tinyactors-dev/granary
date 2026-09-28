/** Liveness (ADR 0163): 200 whenever the HTTP server answers. No auth, no config. */
import type { RequestHandler } from './$types';
import type { HealthzResponse } from '$lib/schemas/health';
import { VERSION } from '$lib/version';

export const GET: RequestHandler = () => {
	const body: HealthzResponse = { status: 'ok', version: VERSION };
	return Response.json(body, { headers: { 'cache-control': 'no-store' } });
};
