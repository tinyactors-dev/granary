/**
 * `granary` commands other than serve/init/restore (ADR 0159). Commands that
 * change cached state go through the running server's admin socket; with no
 * server running, `admin *`, `login-link`, `config *` open granary.sqlite
 * directly (safe: no caches), and `doctor` runs its offline checks.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck } from '../lib/schemas/admin-socket';
import type { Admin } from '../lib/schemas/admins';
import { DATA_DIR_LAYOUT, EXIT, SYSTEM_DATA_DIR } from '../lib/schemas/cli';
import { loadConfig } from '../lib/schemas/config';
import { AdminStore, AdminStoreError } from '../lib/server/admins';
import { configGet, configSet, parseConfigValue } from '../lib/server/config-kv';
import { offlineChecks } from '../lib/server/doctor';
import { Wal } from '../lib/server/wal';
import { VERSION } from '../lib/version';
import type { Parsed } from './args';
import { CliError, print, viaSocket, viaSocketOrDirect, type Context } from './context';

const ACTOR = 'admin-cli';

/** Parse `15m`, `2h`, `90s`, `1d` → ms. */
export function parseDuration(s: string): number {
	const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
	if (!m) throw new CliError(`invalid duration ${JSON.stringify(s)} (use e.g. 15m, 2h)`, EXIT.usage);
	return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/** Open granary.sqlite (running migrations) for the offline fallback. */
function openDirect<T>(ctx: Context, fn: (admins: AdminStore, origin: string) => T): T {
	const config = loadConfig(ctx.env);
	const wal = new Wal(config.databasePath);
	try {
		const origin = config.origin ?? `http://localhost:${config.port}`;
		return fn(new AdminStore(wal.db), origin);
	} catch (e) {
		if (e instanceof AdminStoreError) throw new CliError(`${e.message} (${e.code})`);
		throw e;
	} finally {
		wal.close();
	}
}

const fmtTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

function adminTable(list: Admin[]): string {
	if (!list.length) return 'no admins yet — add one with `granary admin add <github-login>`';
	const w = Math.max(5, ...list.map((a) => a.login.length));
	return [`${'LOGIN'.padEnd(w)}  SOURCE  ADDED BY         ADDED`, ...list.map((a) => `${a.login.padEnd(w)}  ${a.source.padEnd(6)}  ${a.addedBy.padEnd(15)}  ${fmtTime(a.addedAt)}`)].join('\n');
}

const note = (ctx: Context, via: 'socket' | 'direct') => {
	if (via === 'direct' && !ctx.json) console.error('(granary is not running: wrote granary.sqlite directly)');
};

export async function adminAdd(ctx: Context, p: Parsed): Promise<void> {
	const login = p.args[0]!;
	const r = await viaSocketOrDirect(ctx, 'admin/add', { login }, () => openDirect(ctx, (a) => a.addAdmin(login, ACTOR, 'cli')));
	note(ctx, r.via);
	print(ctx, r.result, () => (r.result.added ? `${r.result.admin.login} is now an admin` : `${r.result.admin.login} was already an admin`));
}

export async function adminRemove(ctx: Context, p: Parsed): Promise<void> {
	const login = p.args[0]!;
	const r = await viaSocketOrDirect(ctx, 'admin/remove', { login }, () => openDirect(ctx, (a) => a.removeAdmin(login, ACTOR)));
	note(ctx, r.via);
	print(ctx, r.result, () => (r.result.removed ? `${r.result.login} is no longer an admin` : `${r.result.login} was not an admin`));
}

export async function adminList(ctx: Context): Promise<void> {
	const r = await viaSocketOrDirect(ctx, 'admin/list', {}, () => openDirect(ctx, (a) => a.listAdmins()));
	print(ctx, r.result, () => adminTable(r.result));
}

export async function loginLink(ctx: Context, p: Parsed): Promise<void> {
	const login = p.args[0]!;
	const ttlMs = parseDuration(String(p.options.ttl ?? '15m'));
	const r = await viaSocketOrDirect(ctx, 'login-link', { login, ttlMs }, () => openDirect(ctx, (a, origin) => a.createLoginLink({ login, ttlMs }, ACTOR, origin)));
	note(ctx, r.via);
	print(ctx, r.result, () =>
		[`One-time sign-in link for ${r.result.login} (valid until ${fmtTime(r.result.expiresAt)}, single use):`, '', `  ${r.result.url}`, '', 'It is shown only once.'].join('\n')
	);
}

export async function githubStatus(ctx: Context): Promise<void> {
	const r = await viaSocket(ctx, 'github/status', {});
	print(ctx, r, () => JSON.stringify(r, null, 2));
}

export async function githubSetupUrl(ctx: Context, p: Parsed): Promise<void> {
	const login = typeof p.options.login === 'string' ? p.options.login : undefined;
	const r = await viaSocket(ctx, 'github/setup-url', login ? { login } : {});
	print(ctx, r, () =>
		[`GitHub setup: ${r.url}`, ...(r.loginLink ? [`Sign in first (one-time, until ${fmtTime(r.loginLink.expiresAt)}): ${r.loginLink.url}`] : [])].join('\n')
	);
}

export async function configGetCmd(ctx: Context, p: Parsed): Promise<void> {
	const key = p.args[0]!;
	const r = await viaSocketOrDirect(ctx, 'config/get', { key }, () => openDirect(ctx, (a) => configGet(a.db, key)));
	print(ctx, r.result, () => `${r.result.key} = ${JSON.stringify(r.result.value)}  (${r.result.source})`);
}

export async function configSetCmd(ctx: Context, p: Parsed): Promise<void> {
	const key = p.args[0]!;
	const value = parseConfigValue(p.args[1]!);
	const r = await viaSocketOrDirect(ctx, 'config/set', { key, value }, () => openDirect(ctx, (a) => configSet(a.db, key, value, 'cli', ACTOR)));
	note(ctx, r.via);
	print(ctx, r.result, () => `${r.result.key} = ${JSON.stringify(r.result.value)}`);
}

export async function configSeed(ctx: Context): Promise<void> {
	const r = await viaSocketOrDirect(ctx, 'config/seed', {}, () =>
		openDirect(ctx, (a) => ({ applied: a.seedAdmins(loadConfig(ctx.env).seedAdmins).map((l) => `admin:${l}`) }))
	);
	note(ctx, r.via);
	print(ctx, r.result, () => (r.result.applied.length ? `applied: ${r.result.applied.join(', ')}` : 'nothing to seed (seeds never overwrite existing values)'));
}

export async function backupNow(ctx: Context, p: Parsed): Promise<void> {
	const plan = typeof p.options.plan === 'string' ? p.options.plan : undefined;
	const r = await viaSocket(ctx, 'backup/now', plan ? { plan } : {});
	print(ctx, r, () => (r.runs.length ? r.runs.map((x) => `started ${x.runId} (plan ${x.planId})`).join('\n') : 'no enabled backup plans'));
}

export async function backupList(ctx: Context): Promise<void> {
	const r = await viaSocket(ctx, 'backup/list', { limit: 20 });
	print(ctx, r, () =>
		r.length ? r.map((x) => `${x.runId}  ${x.planId}  ${x.state.padEnd(10)}  ${fmtTime(x.startedAt)}${x.finishedAt ? ` → ${fmtTime(x.finishedAt)}` : ''}`).join('\n') : 'no backup runs yet'
	);
}

function renderChecks(checks: DoctorCheck[]): string {
	const mark = { ok: '✔', warn: '!', fail: '✘' } as const;
	const w = Math.max(...checks.map((c) => c.name.length));
	return checks.map((c) => `${mark[c.status]} ${c.name.padEnd(w)}  ${c.detail}`).join('\n');
}

export async function doctor(ctx: Context): Promise<number> {
	const origin = ctx.env.ORIGIN ?? null;
	const offline = offlineChecks({ dataDir: ctx.dataDir, env: ctx.env, origin });
	let server: { checks: DoctorCheck[]; setup: unknown } | null = null;
	let serverNote: DoctorCheck;
	try {
		const r = await viaSocket(ctx, 'doctor', {});
		server = r;
		serverNote = { name: 'server', status: 'ok', detail: `reachable on ${ctx.socketPath}` };
	} catch (e) {
		serverNote = { name: 'server', status: 'warn', detail: e instanceof Error ? e.message : String(e) };
	}
	// Server-side results replace offline ones with the same name (the server knows better).
	const merged = new Map<string, DoctorCheck>();
	for (const c of [...offline, serverNote, ...(server?.checks ?? [])]) merged.set(c.name, c);
	const checks = [...merged.values()];
	// JSON adds `ok` (status !== 'fail') for scripts; the socket schema stays {name, status, detail}.
	print(ctx, { checks: checks.map((c) => ({ ...c, ok: c.status !== 'fail' })), setup: server?.setup ?? null }, () => renderChecks(checks));
	return checks.some((c) => c.status === 'fail') ? EXIT.error : EXIT.ok;
}

export async function version(ctx: Context): Promise<void> {
	let tinyactors = 'unknown';
	try {
		tinyactors = (await import('@tinyactors/node')).version;
	} catch {
		/* not installed next to the CLI */
	}
	const r = { granary: VERSION, bun: Bun.version, tinyactors };
	print(ctx, r, () => `granary ${r.granary}\nbun ${r.bun}\n@tinyactors/node ${r.tinyactors}`);
}

export function systemdUnit(p: Parsed): string {
	const user = String(p.options.user ?? 'granary');
	const data = typeof p.options.data === 'string' ? p.options.data : SYSTEM_DATA_DIR;
	const bin = typeof p.options.bin === 'string' ? p.options.bin : (process.argv[1] ?? '/usr/local/bin/granary');
	const unitDir = data.replace(/\/+$/, '');
	const stateName = unitDir.startsWith('/var/lib/') ? unitDir.slice('/var/lib/'.length) : null;
	return `# granary — generated by \`granary systemd-unit\` (ADR 0163)
# Install: sudo tee /etc/systemd/system/granary.service < this file
#          sudo systemctl daemon-reload && sudo systemctl enable --now granary
[Unit]
Description=granary (GitHub issue gatekeeper)
Documentation=https://github.com/tinyactors-dev/granary/tree/main/docs/manual
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
ExecStart=${process.execPath} --no-env-file ${bin} serve --data ${unitDir}
# Process-level settings (ORIGIN, PORT, HOST, GRANARY_MASTER_KEY, …); everything else is in-product.
EnvironmentFile=-${join(unitDir, DATA_DIR_LAYOUT.envFile)}
Environment=NODE_ENV=production
${stateName ? `StateDirectory=${stateName}\nStateDirectoryMode=0700\n` : ''}Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${unitDir}
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

/** True when the data dir looks initialised (for hints). */
export function initialised(ctx: Context): boolean {
	return existsSync(join(ctx.dataDir, DATA_DIR_LAYOUT.masterKey)) || existsSync(ctx.envFile);
}
