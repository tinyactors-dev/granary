/**
 * The admin socket (ADR 0159): HTTP/1.1 over `<data>/admin.sock` (mode 0600,
 * data dir 0700). `POST /v1/<command>` with a JSON body; every body is
 * validated with `ADMIN_COMMANDS` on both ends. Commands run through the same
 * Backend / OpsBackend methods the UI uses (so actor caches stay current),
 * with actor `admin-cli`. There is no other authentication: file permissions
 * are the boundary.
 */
import type { Server } from 'bun';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import {
	ADMIN_COMMANDS,
	ADMIN_SOCKET_ACTOR,
	ADMIN_SOCKET_PREFIX,
	type AdminCommandPath,
	type AdminErrorCode,
	type DoctorCheck
} from '../schemas/admin-socket';
import { DATA_DIR_LAYOUT } from '../schemas/cli';
import { issuesOf } from '../schemas/standard';
import { getOpsBackend, hasOpsBackend } from '$lib/ops/contract';
import { BackendError, type Backend } from './backend';
import type { AdminStore } from './admins';
import { configGet, configSet } from './config-kv';
import { checkDatabase, checkDisk, checkOrigin } from './doctor';
import { log } from './log';
import { masterKeyStatus } from './secrets';

/** macOS/Linux limit unix socket paths to ~104/108 bytes. */
const MAX_SOCKET_PATH = 100;

export interface AdminSocketDeps {
	backend: Backend;
	admins: AdminStore;
	dataDir: string;
	origin: string;
	databasePath: string;
	/** Applies env seeds now; returns what was applied (`config seed`). */
	seed(): string[];
	/** Server-side checks beyond the offline ones (system, GitHub, ops). */
	systemCheck(): DoctorCheck;
}

type Handler = (body: never) => Promise<unknown> | unknown;

function adminError(code: AdminErrorCode, message: string, status: number): Response {
	return Response.json({ ok: false, error: { code, message } }, { status });
}

function toAdminError(e: unknown): Response {
	if (e instanceof BackendError) {
		const code: AdminErrorCode = e.code === 'upstream' ? 'unavailable' : e.code;
		const status = { 'not-found': 404, conflict: 409, invalid: 400, unavailable: 503, internal: 500 }[code];
		return adminError(code, e.message, status);
	}
	if (e instanceof Error && 'code' in e && typeof e.code === 'string') {
		const c = e.code;
		if (c === 'not-found' || c === 'conflict' || c === 'invalid') return adminError(c, e.message, c === 'not-found' ? 404 : c === 'conflict' ? 409 : 400);
		if (c === 'degraded' || c === 'unavailable') return adminError('unavailable', e.message, 503);
	}
	log.error('admin socket: command failed', e);
	return adminError('internal', e instanceof Error ? e.message : String(e), 500);
}

export function adminHandlers(d: AdminSocketDeps): { [K in AdminCommandPath]: Handler } {
	const actor = ADMIN_SOCKET_ACTOR;
	return {
		'admin/add': (b: { login: string }) => d.backend.addAdmin(b.login, actor, 'cli'),
		'admin/remove': (b: { login: string }) => d.backend.removeAdmin(b.login, actor),
		'admin/list': () => d.backend.listAdmins(),
		'login-link': (b: { login: string; ttlMs?: number }) => d.backend.createLoginLink({ login: b.login, ttlMs: b.ttlMs }, actor),
		'github/status': () => d.backend.getGitHubStatus(),
		'github/setup-url': async (b: { login?: string }) => {
			const url = `${d.origin}/settings/github`;
			if (!b.login) return { url };
			return { url, loginLink: await d.backend.createLoginLink({ login: b.login }, actor) };
		},
		'config/get': (b: { key: string }) => configGet(d.admins.db, b.key),
		'config/set': (b: { key: string; value: unknown }) => configSet(d.admins.db, b.key, b.value, 'cli', actor),
		'config/seed': () => ({ applied: d.seed() }),
		'backup/now': async (b: { plan?: string }) => {
			if (!hasOpsBackend()) throw new BackendError('unavailable', 'the ops module is not running');
			const ops = getOpsBackend();
			const plans = (await ops.listPlans()).filter((p) => (b.plan ? p.id === b.plan : p.enabled));
			if (b.plan && plans.length === 0) throw new BackendError('not-found', `backup plan ${b.plan} not found`);
			const runs: { planId: string; runId: string }[] = [];
			for (const p of plans) for (const r of await ops.runBackupNow(p.id, actor)) runs.push({ planId: p.id, runId: r.id });
			return { runs };
		},
		'backup/list': async (b: { limit?: number }) => {
			if (!hasOpsBackend()) throw new BackendError('unavailable', 'the ops module is not running');
			const page = await getOpsBackend().listRuns({ limit: b.limit ?? 20 } as never);
			return page.items.map((r) => ({ runId: r.id, planId: r.planId, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt }));
		},
		doctor: async () => {
			const checks: DoctorCheck[] = [d.systemCheck(), checkDatabase(d.databasePath, 'granary'), checkDisk(d.dataDir), checkOrigin(d.origin)];
			checks.push(
				masterKeyStatus() === 'ok'
					? { name: 'master-key', status: 'ok', detail: 'loaded by the server' }
					: { name: 'master-key', status: 'fail', detail: 'the server has no master key: secrets and backups are disabled' }
			);
			try {
				const gh = await d.backend.getGitHubStatus();
				checks.push({ name: 'github', status: gh.mode === 'none' ? 'warn' : 'ok', detail: `mode ${gh.mode}` });
			} catch (e) {
				checks.push({ name: 'github', status: 'warn', detail: e instanceof Error ? e.message : String(e) });
			}
			if (hasOpsBackend()) {
				try {
					const st = await getOpsBackend().getStatus();
					checks.push({ name: 'ops', status: st.sleepOk ? 'ok' : 'warn', detail: st.sleepOk ? 'sleeping is fine' : st.reasons.join('; ') || 'needs attention' });
				} catch (e) {
					checks.push({ name: 'ops', status: 'warn', detail: e instanceof Error ? e.message : String(e) });
				}
			} else checks.push({ name: 'ops', status: 'warn', detail: 'the ops module is not running' });
			return { checks, setup: await d.backend.getSetupStatus() };
		}
	} as never;
}

/** Handle one request (exported for tests and the stub). */
export async function handleAdminRequest(req: Request, handlers: ReturnType<typeof adminHandlers>): Promise<Response> {
	const url = new URL(req.url);
	if (req.method !== 'POST' || !url.pathname.startsWith(ADMIN_SOCKET_PREFIX)) return adminError('not-found', `unknown endpoint ${req.method} ${url.pathname}`, 404);
	const cmd = url.pathname.slice(ADMIN_SOCKET_PREFIX.length) as AdminCommandPath;
	const spec = (ADMIN_COMMANDS as Record<string, { request: TSchema; response: TSchema }>)[cmd];
	if (!spec) return adminError('not-found', `unknown command ${cmd}`, 404);
	let body: unknown;
	try {
		const text = await req.text();
		body = text ? JSON.parse(text) : {};
	} catch {
		return adminError('invalid', 'body is not JSON', 400);
	}
	const bad = issuesOf(spec.request, body);
	if (bad.length) return adminError('invalid', bad.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '), 400);
	try {
		const result = await (handlers[cmd] as (b: unknown) => unknown)(body);
		const out = issuesOf(spec.response, result);
		if (out.length) log.warn(`admin socket: ${cmd} response does not match its schema: ${out.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
		return Response.json({ ok: true, result });
	} catch (e) {
		return toAdminError(e);
	}
}

const KEY = Symbol.for('granary.admin-socket');
const g = globalThis as { [KEY]?: { server: Server<unknown>; path: string } };

/**
 * Listen on `<dataDir>/admin.sock`. A stale socket file (no listener) is
 * replaced. Returns the socket path, or null when it cannot be opened
 * (logged; the CLI then reports the server as unreachable).
 */
export function startAdminSocket(d: AdminSocketDeps): string | null {
	if (g[KEY]) return g[KEY].path;
	const path = join(d.dataDir, DATA_DIR_LAYOUT.adminSocket);
	if (path.length > MAX_SOCKET_PATH) {
		log.warn(`admin socket disabled: ${path} is longer than ${MAX_SOCKET_PATH} bytes (unix socket limit); use a shorter data dir`);
		return null;
	}
	try {
		mkdirSync(d.dataDir, { recursive: true, mode: 0o700 });
		const mode = statSync(d.dataDir).mode & 0o777;
		if (mode & 0o077) {
			chmodSync(d.dataDir, 0o700);
			log.info(`data dir ${d.dataDir}: permissions tightened from ${mode.toString(8)} to 700 (ADR 0159)`);
		}
		if (existsSync(path)) rmSync(path);
		const handlers = adminHandlers(d);
		const server = Bun.serve({ unix: path, fetch: (req) => handleAdminRequest(req, handlers) });
		chmodSync(path, 0o600);
		g[KEY] = { server, path };
		log.info(`admin socket: ${path}`);
		return path;
	} catch (e) {
		log.warn(`admin socket disabled: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

export function stopAdminSocket(): void {
	const s = g[KEY];
	if (!s) return;
	delete g[KEY];
	try {
		s.server.stop(true);
	} catch {
		/* already stopped */
	}
	try {
		rmSync(s.path, { force: true });
	} catch {
		/* ignore */
	}
}
