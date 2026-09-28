/**
 * Load generator HTTP API (ADR 0070): what the dev portal talks to.
 *
 *   GET  /api/status                      LoadgenStatus
 *   GET  /api/presets                     PresetInfo[]
 *   GET  /api/kinds                       PersonaKindInfo[] (with statecharts)
 *   GET  /api/scenarios                   ScenarioSummary[]
 *   POST /api/scenarios                   CreateScenarioRequest → ScenarioSummary
 *   GET  /api/scenarios/:id               ScenarioDetail
 *   POST /api/scenarios/:id/{start,pause,resume,stop} → ScenarioSummary
 *   GET  /api/personas?scenarioId=&kind=  PersonaSummary[]
 *   GET  /api/personas/:kind/:name        PersonaDetail
 *   POST /api/reset                       {ok:true}
 *
 * Env: see loadgen/config.ts.
 */
import { CreateScenarioRequest, ListPersonasQuery, PERSONA_KINDS, type PersonaKind, type ScenarioAction } from './schemas';
import { issuesOf } from '../src/lib/schemas/standard';
import { presetInfos } from './plan';
import { createLoadgen, LoadgenError } from './engine';
import { loadgenConfig } from './config';

const config = loadgenConfig();
const engine = createLoadgen({
	fakeGithubUrl: config.fakeGithubUrl,
	allowlisted: config.allowlisted,
	granaryLogin: config.granaryLogin,
	otlpEndpoint: config.otlpEndpoint
});

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string, issues?: unknown) => json(issues ? { error, issues } : { error }, status);

async function body(req: Request): Promise<unknown> {
	const text = await req.text();
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch (e) {
		throw new LoadgenError(400, `Malformed JSON: ${(e as Error).message}`);
	}
}

const ACTIONS = new Set<ScenarioAction>(['start', 'pause', 'resume', 'stop']);

async function route(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	const m = req.method;
	if (path === '/healthz') return json({ ok: true });
	if (m === 'GET' && path === '/api/status') return json(engine.status());
	if (m === 'GET' && path === '/api/presets') return json(presetInfos());
	if (m === 'GET' && path === '/api/kinds') return json(engine.kinds());
	if (path === '/api/scenarios') {
		if (m === 'GET') return json(engine.listScenarios());
		if (m === 'POST') {
			const b = await body(req);
			const issues = issuesOf(CreateScenarioRequest, b);
			if (issues.length) return fail(400, 'Invalid scenario request', issues);
			return json(await engine.createScenario(b as CreateScenarioRequest), 201);
		}
	}
	const sc = /^\/api\/scenarios\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
	if (sc) {
		const id = decodeURIComponent(sc[1]!);
		if (!sc[2] && m === 'GET') return json(engine.getScenario(id));
		if (sc[2] && m === 'POST' && ACTIONS.has(sc[2] as ScenarioAction)) {
			return json(await engine.control(id, sc[2] as ScenarioAction));
		}
	}
	if (m === 'GET' && path === '/api/personas') {
		const q = Object.fromEntries(url.searchParams);
		const issues = issuesOf(ListPersonasQuery, q);
		if (issues.length) return fail(400, 'Invalid query', issues);
		return json(engine.listPersonas(q as { scenarioId?: string; kind?: PersonaKind }));
	}
	const pe = /^\/api\/personas\/([^/]+)\/([^/]+)$/.exec(path);
	if (pe && m === 'GET') {
		const kind = decodeURIComponent(pe[1]!);
		if (!(PERSONA_KINDS as readonly string[]).includes(kind)) return fail(404, `Unknown persona kind ${kind}`);
		return json(engine.getPersona(kind, decodeURIComponent(pe[2]!)));
	}
	if (m === 'POST' && path === '/api/reset') {
		engine.reset();
		return json({ ok: true });
	}
	return fail(404, `No route for ${m} ${path}`);
}

const server = Bun.serve({
	port: config.port,
	idleTimeout: 60,
	async fetch(req) {
		try {
			return await route(req);
		} catch (e) {
			if (e instanceof LoadgenError) return fail(e.status, e.message, e.issues);
			console.error('[loadgen]', req.method, req.url, e);
			return fail(500, (e as Error).message);
		}
	}
});

console.log(
	`[loadgen] listening on ${server.url}; fake GitHub ${config.fakeGithubUrl}; allowlisted ${config.allowlisted.join(', ') || '(none)'}`
);

const shutdown = () => {
	server.stop(true);
	engine.close();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
