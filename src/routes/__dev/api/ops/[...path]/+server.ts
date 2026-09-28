/**
 * Dev-only JSON surface over the OpsBackend (ADR 0150): for curl/scripting in
 * development and for the ops scenario tests, which drive the running app
 * through it (the /ops pages use remote functions, whose endpoints aren't a
 * stable surface). 404 unless dev mode is on (hooks also 404 all of /__dev).
 *
 *   GET  status | conditions | events | plans | destinations | runs | runs/<id>
 *        drills | sinks | sinks/<id>/stats | secrets | keys | budgets | actors
 *   POST backup-now {planId} | drill-now {destinationId} | acknowledge {id}
 *        budgets {…Budgets}
 */
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getOpsBackend, hasOpsBackend, isOpsBackendError, opsBackendErrorStatus } from '$lib/ops/contract';

const ACTOR = 'dev-api';

function limitOf(url: URL): number {
	const n = Number(url.searchParams.get('limit') ?? 50);
	return Number.isInteger(n) && n > 0 && n <= 500 ? n : 50;
}

async function run<T>(f: () => Promise<T>): Promise<Response> {
	try {
		return json(await f());
	} catch (e) {
		if (isOpsBackendError(e)) return json({ code: e.code, message: e.message }, { status: opsBackendErrorStatus(e.code) });
		throw e;
	}
}

function guard(locals: App.Locals) {
	if (!locals.devMode) error(404, 'Not Found');
	if (!hasOpsBackend()) error(503, 'ops backend not registered');
	return getOpsBackend();
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
	const ops = guard(locals);
	const parts = (params.path ?? '').split('/').filter(Boolean);
	const limit = limitOf(url);
	switch (parts[0]) {
		case 'status':
			return run(() => ops.getStatus());
		case 'conditions':
			return run(() => ops.listConditions());
		case 'events':
			return run(() => ops.listEvents({ limit }));
		case 'plans':
			return run(() => ops.listPlans());
		case 'destinations':
			return run(() => ops.listDestinations());
		case 'runs':
			return parts[1] ? run(() => ops.getRun(parts[1]!)) : run(() => ops.listRuns({ limit }));
		case 'drills':
			return run(() => ops.listDrills({ limit }));
		case 'sinks':
			return parts[1] && parts[2] === 'stats' ? run(() => ops.getTelemetryStats(parts[1]!)) : run(() => ops.listSinks());
		case 'secrets':
			return run(() => ops.listSecrets());
		case 'keys':
			return run(() => ops.getKeyStatus());
		case 'budgets':
			return run(() => ops.getBudgets());
		case 'actors':
			return run(() => ops.listOpsActors());
	}
	error(404, 'Not Found');
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const ops = guard(locals);
	const parts = (params.path ?? '').split('/').filter(Boolean);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const str = (k: string) => {
		const v = body[k];
		if (typeof v !== 'string' || !v) error(400, `${k} required`);
		return v;
	};
	switch (parts[0]) {
		case 'backup-now':
			return run(() => ops.runBackupNow(str('planId'), ACTOR));
		case 'drill-now':
			return run(() => ops.runDrillNow(str('destinationId'), ACTOR));
		case 'acknowledge':
			return run(() => ops.acknowledgeCondition(str('id'), ACTOR));
		case 'budgets':
			return run(async () => ops.saveBudgets({ ...(await ops.getBudgets()), ...body } as Parameters<typeof ops.saveBudgets>[0], ACTOR));
	}
	error(404, 'Not Found');
};
