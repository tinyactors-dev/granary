/** Liveness (ADR 0163): 200 whenever the HTTP server answers. No auth; says whether this is a sandbox (ADR 0315). */
import type { RequestHandler } from './$types';
import type { HealthzResponse } from '$lib/schemas/health';
import { VERSION } from '$lib/version';
import { env } from '$env/dynamic/private';

export const GET: RequestHandler = () => {
	const sandbox = env.GRANARY_SANDBOX === '1';
	const body: HealthzResponse = { status: 'ok', version: VERSION, sandbox, ...(sandbox && env.ORIGIN ? { origin: env.ORIGIN.replace(/\/+$/, '') } : {}) };
	return Response.json(body, { headers: { 'cache-control': 'no-store' } });
};
