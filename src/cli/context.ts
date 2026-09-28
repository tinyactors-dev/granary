/**
 * What every CLI command needs (ADR 0157, 0159): the data dir, the
 * environment merged with `<data>/granary.env` (process env wins), whether a
 * server is running (pid file + admin socket), and the socket client.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { ADMIN_COMMANDS, ADMIN_SOCKET_PREFIX, type AdminCommandPath, type AdminRequest, type AdminResponse } from '../lib/schemas/admin-socket';
import { DATA_DIR_LAYOUT, EXIT } from '../lib/schemas/cli';
import { resolveDataDir } from '../lib/schemas/config';
import { issuesOf } from '../lib/schemas/standard';

export class CliError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode: number = EXIT.error) {
		super(message);
		this.name = 'CliError';
		this.exitCode = exitCode;
	}
}

/** `KEY=value` lines; `#` comments; optional single/double quotes; `export ` prefix allowed. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2]!;
		if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
		else v = v.replace(/\s+#.*$/, '');
		out[m[1]!] = v;
	}
	return out;
}

export interface Context {
	dataDir: string;
	/** process.env merged over `<data>/granary.env`. */
	env: Record<string, string | undefined>;
	envFile: string;
	envFileVars: Record<string, string>;
	socketPath: string;
	pidFile: string;
	json: boolean;
}

export function createContext(options: Record<string, string | boolean>): Context {
	const flag = typeof options.data === 'string' ? options.data : null;
	const dataDir = resolve(resolveDataDir(process.env, flag));
	const envFile = join(dataDir, DATA_DIR_LAYOUT.envFile);
	let envFileVars: Record<string, string> = {};
	if (existsSync(envFile)) {
		try {
			envFileVars = parseEnvFile(readFileSync(envFile, 'utf8'));
		} catch (e) {
			throw new CliError(`cannot read ${envFile}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return {
		dataDir,
		env: { ...envFileVars, ...process.env, GRANARY_DATA_DIR: dataDir },
		envFile,
		envFileVars,
		socketPath: join(dataDir, DATA_DIR_LAYOUT.adminSocket),
		pidFile: join(dataDir, DATA_DIR_LAYOUT.pidFile),
		json: options.json === true
	};
}

/** The pid in `<data>/granary.pid` if that process is alive. */
export function livePid(ctx: Context): number | null {
	if (!existsSync(ctx.pidFile)) return null;
	const pid = Number.parseInt(readFileSync(ctx.pidFile, 'utf8').trim(), 10);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return pid;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
	}
}

type SocketResult<C extends AdminCommandPath> = { reached: true; result: AdminResponse<C> } | { reached: false; reason: string };

/**
 * POST a command to the admin socket. `reached: false` when nothing listens
 * (no socket file, refused); command errors throw `CliError`.
 */
export async function callSocket<C extends AdminCommandPath>(ctx: Context, cmd: C, body: AdminRequest<C>): Promise<SocketResult<C>> {
	if (!existsSync(ctx.socketPath)) return { reached: false, reason: `no admin socket at ${ctx.socketPath}` };
	let res: Response;
	try {
		res = await fetch(`http://granary${ADMIN_SOCKET_PREFIX}${cmd}`, {
			method: 'POST',
			unix: ctx.socketPath,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120_000)
		});
	} catch (e) {
		return { reached: false, reason: e instanceof Error ? e.message : String(e) };
	}
	let envelope: unknown;
	try {
		envelope = await res.json();
	} catch {
		throw new CliError(`admin socket answered ${res.status} without JSON`);
	}
	const e = envelope as { ok?: boolean; result?: unknown; error?: { code: string; message: string } };
	if (e.ok !== true) throw new CliError(e.error ? `${e.error.message} (${e.error.code})` : `admin socket error ${res.status}`, EXIT.error);
	const schema = (ADMIN_COMMANDS as Record<string, { response: TSchema }>)[cmd]!.response;
	const bad = issuesOf(schema, e.result);
	if (bad.length) throw new CliError(`unexpected response for ${cmd}: ${bad.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
	return { reached: true, result: e.result as AdminResponse<C> };
}

/**
 * Transport for `socket-or-direct` commands (ADR 0159): the socket when a
 * server listens; direct SQLite when no live server holds the pid file.
 */
export async function viaSocketOrDirect<C extends AdminCommandPath, T>(
	ctx: Context,
	cmd: C,
	body: AdminRequest<C>,
	direct: () => T | Promise<T>
): Promise<{ via: 'socket'; result: AdminResponse<C> } | { via: 'direct'; result: T }> {
	const r = await callSocket(ctx, cmd, body);
	if (r.reached) return { via: 'socket', result: r.result };
	const pid = livePid(ctx);
	if (pid !== null)
		throw new CliError(`a granary server (pid ${pid}) is running for ${ctx.dataDir} but its admin socket is unreachable (${r.reason}); refusing to write the database behind it`, EXIT.serverNotRunning);
	return { via: 'direct', result: await direct() };
}

/** Transport for `socket` commands: fails with exit 3 when no server listens. */
export async function viaSocket<C extends AdminCommandPath>(ctx: Context, cmd: C, body: AdminRequest<C>): Promise<AdminResponse<C>> {
	const r = await callSocket(ctx, cmd, body);
	if (r.reached) return r.result;
	throw new CliError(`granary is not running for ${ctx.dataDir} (${r.reason}); start it with \`granary serve\``, EXIT.serverNotRunning);
}

/** For `offline` commands (init, restore): refuse while a server runs. */
export async function requireOffline(ctx: Context, what: string): Promise<void> {
	const pid = livePid(ctx);
	const r = existsSync(ctx.socketPath) ? await callSocket(ctx, 'admin/list', {}).catch(() => ({ reached: true as const })) : { reached: false as const };
	if (pid !== null || r.reached) throw new CliError(`${what} refuses to run while granary is running for ${ctx.dataDir}${pid ? ` (pid ${pid})` : ''}; stop it first`);
}

export function print(ctx: Context, result: unknown, human: () => string): void {
	if (ctx.json) console.log(JSON.stringify(result, null, 2));
	else console.log(human());
}
