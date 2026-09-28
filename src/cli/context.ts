/**
 * What every CLI command needs (ADR 0157, 0159): the data dir, the
 * environment merged with `<data>/granary.env` (process env wins), whether a
 * server is running (pid file + admin socket), and the socket client.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { ADMIN_COMMANDS, ADMIN_SOCKET_PREFIX, type AdminCommandPath, type AdminRequest, type AdminResponse } from '../lib/schemas/admin-socket';
import { DATA_DIR_LAYOUT, EXIT, SYSTEM_DATA_DIR } from '../lib/schemas/cli';
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

/** How the CLI picked its data dir (ADR 0232), for error messages. */
export type DataDirSource = 'flag' | 'env' | 'system' | 'default';

const SOURCE_TEXT: Record<DataDirSource, string> = {
	flag: 'from --data',
	env: 'from GRANARY_DATA_DIR',
	system: 'the system data dir, which exists on this host',
	default: 'the per-user default: $XDG_STATE_HOME/granary or ~/.local/state/granary'
};

/**
 * The CLI's data dir (ADR 0232): `--data` > `GRANARY_DATA_DIR` >
 * `/var/lib/granary` when it exists > the per-user XDG default. The system
 * dir wins over the per-user default so that an admin on a server never
 * silently gets a second, empty data dir in their home.
 */
export function resolveCliDataDir(env: Record<string, string | undefined>, flag: string | null): { path: string; source: DataDirSource } {
	if (flag) return { path: resolve(resolveDataDir(env, flag)), source: 'flag' };
	if (env.GRANARY_DATA_DIR) return { path: resolve(resolveDataDir(env)), source: 'env' };
	// GRANARY_TEST_SYSTEM_DATA_DIR stands in for /var/lib/granary in tests (no root needed).
	const system = env.GRANARY_TEST_SYSTEM_DATA_DIR || SYSTEM_DATA_DIR;
	if (existsSync(system)) return { path: resolve(system), source: 'system' };
	return { path: resolve(resolveDataDir(env)), source: 'default' };
}

export interface Context {
	dataDir: string;
	dataDirSource: DataDirSource;
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
	const { path: dataDir, source: dataDirSource } = resolveCliDataDir(process.env, flag);
	const envFile = join(dataDir, DATA_DIR_LAYOUT.envFile);
	let envFileVars: Record<string, string> = {};
	if (accessible(dataDir) && existsSync(envFile)) {
		try {
			envFileVars = parseEnvFile(readFileSync(envFile, 'utf8'));
		} catch (e) {
			throw new CliError(`cannot read ${envFile}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return {
		dataDir,
		dataDirSource,
		env: { ...envFileVars, ...process.env, GRANARY_DATA_DIR: dataDir },
		envFile,
		envFileVars,
		socketPath: join(dataDir, DATA_DIR_LAYOUT.adminSocket),
		pidFile: join(dataDir, DATA_DIR_LAYOUT.pidFile),
		json: options.json === true
	};
}

function accessible(dir: string): boolean {
	try {
		accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The login name for a uid from /etc/passwd, else the uid itself. */
function userName(uid: number): string {
	try {
		for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
			const f = line.split(':');
			if (f.length > 2 && Number(f[2]) === uid) return f[0]!;
		}
	} catch {
		/* no /etc/passwd */
	}
	try {
		// macOS keeps users in directory services, not /etc/passwd.
		const r = Bun.spawnSync(['id', '-nu', String(uid)], { stderr: 'ignore' });
		const name = r.stdout.toString().trim();
		if (r.exitCode === 0 && name) return name;
	} catch {
		/* no `id` */
	}
	return String(uid);
}

function currentUser(): string {
	return process.env.USER ?? process.env.LOGNAME ?? (typeof process.getuid === 'function' ? userName(process.getuid()) : 'this user');
}

/** The command line as typed, for a copyable `sudo -u …` hint. */
function commandLine(): string {
	return ['granary', ...process.argv.slice(2)].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** True when the data dir holds anything `granary init` or `granary serve` creates. */
export function isInitialised(dataDir: string): boolean {
	return [DATA_DIR_LAYOUT.envFile, DATA_DIR_LAYOUT.masterKey, DATA_DIR_LAYOUT.database].some((f) => existsSync(join(dataDir, f)));
}

/**
 * Guard for every command that reads or writes a data dir (ADR 0232): the
 * dir must be accessible as the current user and — unless `allowUninitialised`
 * (init, serve) — already initialised. Never falls back to another dir and
 * never creates anything; fails with exit 4 naming the path and how it was
 * chosen.
 */
export function requireDataDir(ctx: Context, opts: { allowMissing?: boolean; allowUninitialised?: boolean } = {}): void {
	const where = `${ctx.dataDir} (${SOURCE_TEXT[ctx.dataDirSource]})`;
	if (!existsSync(ctx.dataDir)) {
		if (opts.allowMissing) return;
		throw new CliError(
			[
				`data dir ${where} does not exist; nothing was created.`,
				`Point the CLI at granary's data dir, e.g. \`--data ${SYSTEM_DATA_DIR}\` (or GRANARY_DATA_DIR), and run it as that dir's owner (\`sudo -u granary …\`),`,
				`or create a new one with \`granary init --data <dir>\`.`
			].join('\n'),
			EXIT.dataDir
		);
	}
	if (!accessible(ctx.dataDir)) {
		let owner = 'its owner';
		let mode = '';
		try {
			const st = statSync(ctx.dataDir);
			owner = userName(st.uid);
			mode = `, mode ${(st.mode & 0o777).toString(8)}`;
		} catch {
			/* keep the generic owner */
		}
		throw new CliError(
			[
				`cannot access data dir ${where} as ${currentUser()} (owned by ${owner}${mode}); nothing was written.`,
				`Run as the data dir's owner:`,
				`  sudo -u ${owner} ${commandLine()}`
			].join('\n'),
			EXIT.dataDir
		);
	}
	if (!opts.allowUninitialised && !isInitialised(ctx.dataDir))
		throw new CliError(
			[
				`data dir ${where} is not initialised (no ${DATA_DIR_LAYOUT.envFile}, ${DATA_DIR_LAYOUT.masterKey} or ${DATA_DIR_LAYOUT.database}); nothing was created.`,
				`If granary lives elsewhere, pass \`--data <dir>\` (e.g. ${SYSTEM_DATA_DIR}); to set up this dir, run \`granary init --data ${ctx.dataDir}\`.`
			].join('\n'),
			EXIT.dataDir
		);
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
