/**
 * Readiness (ADR 0163): 200 when granary.sqlite is open and the actor system
 * booted (boot re-post done), 503 otherwise. `masterKey`, `github` and `ops`
 * inform but don't affect readiness. No auth; nothing secret in the body.
 */
import type { RequestHandler } from './$types';
import type { ReadyzResponse } from '$lib/schemas/health';
import { VERSION } from '$lib/version';
import { getBackend, hasBackend } from '$lib/server/backend';
import { getRuntime } from '$lib/server/system';
import { isReady, uptimeSeconds } from '$lib/server/readiness';
import { masterKeyStatus } from '$lib/server/secrets';
import { getOpsBackend, hasOpsBackend } from '$lib/ops/contract';

export const GET: RequestHandler = async () => {
	const rt = getRuntime();
	let database: 'ok' | 'fail' = 'fail';
	try {
		if (rt && !rt.closed) {
			rt.wal.db.query('SELECT 1').get();
			database = 'ok';
		}
	} catch {
		database = 'fail';
	}
	const system: 'ok' | 'fail' = rt && !rt.closed && isReady() ? 'ok' : 'fail';
	let github: ReadyzResponse['checks']['github'] = 'error';
	if (hasBackend()) {
		try {
			github = (await getBackend().getSetupStatus()).state === 'ready' ? 'ready' : 'needs-github';
		} catch {
			github = 'error';
		}
	}
	let ops: ReadyzResponse['checks']['ops'] = 'unavailable';
	if (hasOpsBackend()) {
		try {
			ops = (await getOpsBackend().getStatus()).sleepOk ? 'ok' : 'attention';
		} catch {
			ops = 'unavailable';
		}
	}
	const ready = database === 'ok' && system === 'ok';
	const body: ReadyzResponse = {
		ready,
		version: VERSION,
		uptimeSeconds: Math.round(uptimeSeconds()),
		checks: { database, system, masterKey: masterKeyStatus(), github, ops }
	};
	return Response.json(body, { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } });
};
