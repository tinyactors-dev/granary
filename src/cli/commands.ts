/**
 * `granary` commands other than serve/init/restore (ADR 0159). Commands that
 * change cached state go through the running server's admin socket; with no
 * server running, `admin *`, `login-link`, `config *` open granary.sqlite
 * directly (safe: no caches), and `doctor` runs its offline checks.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck } from '../lib/schemas/admin-socket';
import type { Admin, SetupStatus } from '../lib/schemas/admins';
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

/**
 * Open granary.sqlite (running migrations) for the offline fallback. Only
 * reached after `requireDataDir` (ADR 0232), so this never creates a
 * database in a dir `granary init` didn't set up.
 */
function openDirect<T>(ctx: Context, fn: (admins: AdminStore, origin: string | null) => T): T {
	const config = loadConfig(ctx.env);
	const wal = new Wal(config.databasePath);
	try {
		return fn(new AdminStore(wal.db), config.origin);
	} catch (e) {
		if (e instanceof AdminStoreError) throw new CliError(`${e.message} (${e.code})`);
		throw e;
	} finally {
		wal.close();
	}
}

export const noOriginMessage = (ctx: Context) =>
	`no ORIGIN configured for ${ctx.dataDir}: a sign-in link must use granary's public URL. Set ORIGIN=https://… in ${ctx.envFile} (then restart granary if it runs) and try again.`;

const fmtTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

function adminTable(list: Admin[]): string {
	if (!list.length) return 'no admins yet — add one with `granary admin add <github-login>`';
	const w = Math.max(5, ...list.map((a) => a.login.length));
	return [`${'LOGIN'.padEnd(w)}  SOURCE  ADDED BY         ADDED`, ...list.map((a) => `${a.login.padEnd(w)}  ${a.source.padEnd(6)}  ${a.addedBy.padEnd(15)}  ${fmtTime(a.addedAt)}`)].join('\n');
}

const note = (ctx: Context, via: 'socket' | 'direct') => {
	if (via === 'direct' && !ctx.json) console.error(`(granary is not running for ${ctx.dataDir}: wrote its granary.sqlite directly)`);
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

// -- blocklist (ADR 0260) -------------------------------------------------------------------

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(\[bot\])?$/;

type BlockedView = { login: string; note: string | null; expiresAt: number | null; addedBy: string | null; addedAt: number; active: boolean; isAdmin: boolean };

/**
 * Direct-mode blocklist access (no server running): granary.sqlite only.
 * Safe without the socket because `allowlist/main` reads blocked_users at boot.
 */
function openDirectWal<T>(ctx: Context, fn: (wal: Wal, admins: AdminStore) => T): T {
	const wal = new Wal(loadConfig(ctx.env).databasePath);
	try {
		return fn(wal, new AdminStore(wal.db));
	} finally {
		wal.close();
	}
}

const blockedView = (r: { login: string; note: string | null; expires_at: number | null; added_by: string | null; added_at: number }, admins: AdminStore, now = Date.now()): BlockedView => ({
	login: r.login,
	note: r.note,
	expiresAt: r.expires_at,
	addedBy: r.added_by,
	addedAt: r.added_at,
	active: r.expires_at === null || r.expires_at > now,
	isAdmin: admins.isAdmin(r.login)
});

function blockedTable(list: BlockedView[]): string {
	if (!list.length) return 'nobody is blocked — block a login with `granary blocklist add <github-login> [--for 1h]`';
	const w = Math.max(5, ...list.map((b) => b.login.length));
	const until = (b: BlockedView) => (b.expiresAt === null ? 'until removed' : `${b.active ? 'until' : 'expired'} ${fmtTime(b.expiresAt)}`);
	return [
		`${'LOGIN'.padEnd(w)}  STATE    UNTIL                          NOTE`,
		...list.map((b) => `${b.login.padEnd(w)}  ${(b.active ? 'blocked' : 'expired').padEnd(7)}  ${until(b).padEnd(29)}  ${b.note ?? ''}${b.isAdmin && b.active ? '  (admin: their own issues are closed)' : ''}`)
	].join('\n');
}

export async function blocklistAdd(ctx: Context, p: Parsed): Promise<void> {
	const login = p.args[0]!;
	if (!GITHUB_LOGIN.test(login)) throw new CliError(`not a valid GitHub login: ${login}`, EXIT.usage);
	const forMs = typeof p.options.for === 'string' ? parseDuration(p.options.for) : null;
	const noteText = typeof p.options.note === 'string' && p.options.note.trim() ? p.options.note.trim() : undefined;
	const r = await viaSocketOrDirect(ctx, 'blocklist/add', { login, forMs, ...(noteText ? { note: noteText } : {}) }, () =>
		openDirectWal(ctx, (wal, admins) => {
			const now = Date.now();
			const expiresAt = forMs === null ? null : now + forMs;
			const { row, added } = wal.blockUser(login, { note: noteText ?? null, expiresAt, addedBy: ACTOR }, now);
			admins.audit(ACTOR, 'blocklist.add', row.login, { expiresAt, note: noteText ?? null });
			return { user: blockedView(row, admins, now), added };
		})
	);
	note(ctx, r.via);
	const u = r.result.user;
	print(ctx, r.result, () =>
		[
			`${u.login} is ${r.result.added ? 'now' : 'still'} blocked ${u.expiresAt === null ? 'until removed' : `until ${fmtTime(u.expiresAt)}`}`,
			...(u.isAdmin ? [`note: ${u.login} is an admin — issues they open will be closed while the block lasts`] : [])
		].join('\n')
	);
}

export async function blocklistRemove(ctx: Context, p: Parsed): Promise<void> {
	const login = p.args[0]!;
	const r = await viaSocketOrDirect(ctx, 'blocklist/remove', { login }, () =>
		openDirectWal(ctx, (wal, admins) => {
			const existing = wal.getBlockedUser(login);
			const removed = wal.unblockUser(login);
			if (removed) admins.audit(ACTOR, 'blocklist.remove', existing?.login ?? login, null);
			return { login: existing?.login ?? login, removed };
		})
	);
	note(ctx, r.via);
	print(ctx, r.result, () => (r.result.removed ? `${r.result.login} is no longer blocked` : `${r.result.login} was not blocked`));
}

export async function blocklistList(ctx: Context): Promise<void> {
	const r = await viaSocketOrDirect(ctx, 'blocklist/list', {}, () =>
		openDirectWal(ctx, (wal, admins) => wal.listBlockedUsers().map((row) => blockedView(row, admins)))
	);
	print(ctx, r.result, () => blockedTable(r.result));
}

export async function loginLink(ctx: Context, p: Parsed): Promise<void> {
	const login = p.args[0]!;
	const ttlMs = parseDuration(String(p.options.ttl ?? '15m'));
	const r = await viaSocketOrDirect(ctx, 'login-link', { login, ttlMs }, () =>
		openDirect(ctx, (a, origin) => {
			// A link is only useful at granary's public URL: never guess localhost (ADR 0232).
			if (!origin) throw new CliError(noOriginMessage(ctx), EXIT.error);
			return a.createLoginLink({ login, ttlMs }, ACTOR, origin);
		})
	);
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

/** The setup checklist (ADR 0240), as on /settings. */
function renderSetup(setup: SetupStatus | null): string {
	if (!setup?.steps?.length) return '';
	const mark = { done: '✔', attention: '!', todo: '○' } as const;
	const w = Math.max(...setup.steps.map((s) => s.title.length));
	const lines = setup.steps.map((s) => `${mark[s.status]} ${s.title.padEnd(w)}  ${s.detail}${s.optional ? ' (optional)' : ''}`);
	return `\n\nsetup\n${lines.join('\n')}`;
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
	const setup = (server?.setup ?? null) as SetupStatus | null;
	print(ctx, { checks: checks.map((c) => ({ ...c, ok: c.status !== 'fail' })), setup }, () => renderChecks(checks) + renderSetup(setup));
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
