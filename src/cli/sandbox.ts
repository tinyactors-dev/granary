/**
 * `granary sandbox init` and `granary sandbox serve` (ADR 0312): a second,
 * throwaway granary next to a production one, whose GitHub is the fake
 * GitHub, run as a child process on this machine. Safe by construction:
 *
 * - its own data dir, marked with `sandbox.marker`; `granary serve` refuses a
 *   marked dir and `granary sandbox serve` refuses an unmarked one, so the two
 *   are never mixed up;
 * - its own random master key (nothing real is ever stored in it);
 * - `GRANARY_SANDBOX=1`: the app refuses to start unless its GitHub URLs are
 *   loopback, and shows a sandbox strip on every page;
 * - the app and the fake listen on 127.0.0.1 only: reach them through the
 *   production granary on this machine (Admin → Sandbox, ADR 0315) or an SSH
 *   tunnel. The fake never talks to github.com.
 *
 * The sandbox serves its fake's pages under `/__sandbox/github`; `--via` is
 * the origin browsers reach the sandbox at, the base of its GitHub links.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { DATA_DIR_LAYOUT, EXIT } from '../lib/schemas/cli';
import { generateMasterKey } from '../lib/platform/secrets/keys';
import { isLoopbackUrl } from '../lib/schemas/config';
import type { Parsed } from './args';
import { CliError, type Context } from './context';
import { serve } from './lifecycle';

export const SANDBOX_DEFAULTS = { port: '3100', githubPort: '4010', infraPort: '4090', loadgenPort: '4040', dataDir: '/var/lib/granary-sandbox' } as const;

/** Who the load generator's personas treat as allowlisted; seeded into the sandbox's allowlist too (ADR 0070). */
const SANDBOX_ALLOWLISTED = 'alice,carol,dave';
const fakeSecret = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');

export const isSandboxDir = (dataDir: string): boolean => existsSync(join(dataDir, DATA_DIR_LAYOUT.sandboxMarker));

const port = (v: unknown, fallback: string, what: string): string => {
	const s = typeof v === 'string' ? v : fallback;
	if (!/^[0-9]{2,5}$/.test(s) || Number(s) > 65535) throw new CliError(`--${what} must be a port number (got ${s})`, EXIT.usage);
	return s;
};

/** Where browsers open the fake GitHub's pages: the sandbox serves them under this path (ADR 0315). */
export const SANDBOX_GITHUB_PATH = '/__sandbox/github';

/** The sandbox's granary.env. Everything in it is about this machine only, except where browsers reach it (`via`). */
function sandboxEnv(o: { port: string; githubPort: string; infraPort: string; loadgenPort: string; admins: string; via: string }): string {
	const gh = `http://localhost:${o.githubPort}`;
	const infra = `http://localhost:${o.infraPort}`;
	const pages = `${o.via}${SANDBOX_GITHUB_PATH}`;
	// fake-infra's R2 keys and exe.dev token: made up here, used only between the sandbox and its fake-infra.
	const r2 = { accessKeyId: fakeSecret(16), secret: fakeSecret(32) };
	const exeToken = `exe_sandbox_${fakeSecret(12)}`;
	return `# granary SANDBOX (ADR 0312, 0315) — written by \`granary sandbox init\`.
# GitHub here is the fake GitHub, started by \`granary sandbox serve\` on this machine.
# Use it through ${o.via}: ${o.via.startsWith('http://localhost:') ? `an SSH tunnel,\n#   ssh -L ${o.port}:127.0.0.1:${o.port} <this host>` : 'Admin → Sandbox of the production granary there'}
GRANARY_SANDBOX=1
# Development mode: "log in as" under /admin/sessions and the fake GitHub's controls under /admin.
GRANARY_DEV=1
HOST=127.0.0.1
PORT=${o.port}
ORIGIN=http://localhost:${o.port}
GRANARY_GITHUB_API_URL=${gh}
GRANARY_GITHUB_WEB_URL=${gh}
# Browsers open the fake's pages through the sandbox (ADR 0315).
GRANARY_GITHUB_PAGES_URL=${pages}
GRANARY_DEV_GITHUB_AUTOCONNECT=1
FAKE_GITHUB_URL=${gh}
FAKE_GITHUB_WEB_URL=${pages}
FAKE_GITHUB_PORT=${o.githubPort}
FAKE_GITHUB_HOST=127.0.0.1
GRANARY_SEED_ADMINS=${o.admins}
# The load generator (ADR 0070, 0315): its personas' allowlisted logins are seeded here too.
GRANARY_SEED_ALLOWLIST=${SANDBOX_ALLOWLISTED}
LOADGEN_URL=http://localhost:${o.loadgenPort}
LOADGEN_PORT=${o.loadgenPort}
LOADGEN_HOST=127.0.0.1
LOADGEN_ALLOWLISTED=${SANDBOX_ALLOWLISTED}
# fake-infra (ADR 0130, 0315): fake R2, OTLP receiver and exe.dev proxy fronts (${Number(o.infraPort) + 1}, ${Number(o.infraPort) + 2}).
FAKE_INFRA_URL=${infra}
FAKE_INFRA_PORT=${o.infraPort}
FAKE_INFRA_HOST=127.0.0.1
FAKE_INFRA_SEED_BUCKET=granary-backups
FAKE_INFRA_SEED_JURISDICTION=eu
FAKE_INFRA_SEED_ACCESS_KEY_ID=${r2.accessKeyId}
FAKE_INFRA_SEED_SECRET_ACCESS_KEY=${r2.secret}
FAKE_INFRA_SEED_EXE_TOKEN=${exeToken}
# The sandbox's operations module backs up to fake R2 and sends telemetry to fake-infra, never anywhere real.
GRANARY_SEED_R2_ACCOUNT_ID=00000000000000000000000000000000
GRANARY_SEED_R2_JURISDICTION=eu
GRANARY_SEED_R2_BUCKET=granary-backups
GRANARY_SEED_R2_ACCESS_KEY_ID=${r2.accessKeyId}
GRANARY_SEED_R2_SECRET_ACCESS_KEY=${r2.secret}
GRANARY_SEED_R2_ENDPOINT_OVERRIDE=${infra}/s3/eu
GRANARY_SEED_R2_CONSOLE_URL=${infra}/
GRANARY_SEED_OTLP_ENDPOINT=http://localhost:${Number(o.infraPort) + 1}
GRANARY_SEED_OTLP_AUTH=exe-vm-token
GRANARY_SEED_OTLP_TOKEN=${exeToken}
`;
}

/** `--via`: an origin (scheme, host, optional port; no path). Default: the SSH tunnel's `http://localhost:<port>`. */
function viaOrigin(v: unknown, appPort: string): string {
	if (typeof v !== 'string' || !v.trim()) return `http://localhost:${appPort}`;
	let u: URL;
	try {
		u = new URL(v.trim());
	} catch {
		throw new CliError(`--via must be an origin such as https://granary.example.com (got ${v})`, EXIT.usage);
	}
	if ((u.protocol !== 'https:' && u.protocol !== 'http:') || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username) {
		throw new CliError(`--via must be an origin such as https://granary.example.com, without a path (got ${v})`, EXIT.usage);
	}
	return u.origin;
}

/** `--data` is required: a sandbox is never set up in the default (production) data dir by accident. */
function explicitDataDir(ctx: Context, p: Parsed): void {
	if (typeof p.options.data !== 'string') throw new CliError(`--data is required for sandbox commands, e.g. --data ${SANDBOX_DEFAULTS.dataDir}`, EXIT.usage);
}

export async function sandboxInit(ctx: Context, p: Parsed): Promise<number> {
	explicitDataDir(ctx, p);
	const d = ctx.dataDir;
	if (existsSync(join(d, DATA_DIR_LAYOUT.database)) && !isSandboxDir(d)) {
		throw new CliError(`${d} is a granary data dir, not a sandbox; nothing was changed. Pick another directory, e.g. ${SANDBOX_DEFAULTS.dataDir}`, EXIT.dataDir);
	}
	const appPort = port(p.options.port, SANDBOX_DEFAULTS.port, 'port');
	const githubPort = port(p.options['github-port'], SANDBOX_DEFAULTS.githubPort, 'github-port');
	const infraPort = port(p.options['infra-port'], SANDBOX_DEFAULTS.infraPort, 'infra-port');
	const loadgenPort = port(p.options['loadgen-port'], SANDBOX_DEFAULTS.loadgenPort, 'loadgen-port');
	const taken = [appPort, githubPort, infraPort, String(Number(infraPort) + 1), String(Number(infraPort) + 2), loadgenPort];
	if (new Set(taken).size !== taken.length) throw new CliError('--port, --github-port, --infra-port (and the two after it) and --loadgen-port must all differ', EXIT.usage);
	const admins = typeof p.options.admins === 'string' && p.options.admins.trim() ? p.options.admins.trim() : 'admin';
	if (!/^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$/.test(admins)) throw new CliError('--admins is a comma-separated list of logins', EXIT.usage);
	const via = viaOrigin(p.options.via, appPort);

	mkdirSync(d, { recursive: true, mode: 0o700 });
	chmodSync(d, 0o700);
	const lines = [`sandbox data dir: ${d} (mode 700)`];
	const marker = join(d, DATA_DIR_LAYOUT.sandboxMarker);
	if (!existsSync(marker)) writeFileSync(marker, 'This data dir belongs to a granary sandbox (ADR 0312). `granary serve` refuses it.\n', { mode: 0o600 });
	const keyFile = join(d, DATA_DIR_LAYOUT.masterKey);
	if (!existsSync(keyFile)) {
		writeFileSync(keyFile, generateMasterKey() + '\n', { mode: 0o600 });
		lines.push(`master key: ${keyFile} (a throwaway key: a sandbox never stores anything real)`);
	}
	writeFileSync(ctx.envFile, sandboxEnv({ port: appPort, githubPort, infraPort, loadgenPort, admins, via }), { mode: 0o600 });
	chmodSync(ctx.envFile, 0o600);
	lines.push(
		`env file: ${ctx.envFile} (app on 127.0.0.1:${appPort}, fake GitHub :${githubPort}, fake infra :${infraPort}–${Number(infraPort) + 2}, load generator :${loadgenPort}; used through ${via})`,
		'',
		'Next:',
		`  granary sandbox serve --data ${d}        (or: granary systemd-unit --unit sandbox --data ${d})`,
		...(via.startsWith('http://localhost:')
			? [`  ssh -L ${appPort}:127.0.0.1:${appPort} <this host>`, `  open http://localhost:${appPort}/admin/sessions and log in as ${admins.split(',')[0]}`]
			: [`  open ${via}/admin/sandbox and enter the sandbox`])
	);
	if (ctx.json) console.log(JSON.stringify({ dataDir: d, port: appPort, githubPort, infraPort, loadgenPort, admins: admins.split(','), via, envFile: ctx.envFile }, null, 2));
	else console.log(lines.join('\n'));
	return EXIT.ok;
}

/** A simulation service a sandbox runs (ADR 0312, 0315). */
interface Service {
	name: string;
	/** `<pkg>/dist/<bundle>` next to `dist/cli.js`, else the repository's source. */
	bundle: string;
	source: string;
	url: string;
	health: string;
	env: Record<string, string>;
}

function findEntry(s: Pick<Service, 'name' | 'bundle' | 'source'>): string {
	const here = dirname(new URL(import.meta.url).pathname);
	const candidates = [resolve(here, s.bundle), resolve(here, '../..', s.source), resolve(here, '..', s.source)];
	const found = candidates.find((c) => existsSync(c));
	if (!found) throw new CliError(`cannot find ${s.name} (looked at ${candidates.join(', ')}); in the repository run \`mise run cli\``);
	return found;
}

async function waitHealthy(s: Service, child: Subprocess, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new CliError(`${s.name} exited (${child.exitCode ?? child.signalCode}) before it was ready`);
		try {
			if ((await fetch(`${s.url}${s.health}`, { signal: AbortSignal.timeout(1000) })).ok) return;
		} catch {
			/* not yet */
		}
		await Bun.sleep(150);
	}
	throw new CliError(`${s.name} did not answer at ${s.url}${s.health} within ${timeoutMs / 1000} s`);
}

const pick = (env: Record<string, string | undefined>, prefix: string): Record<string, string> =>
	Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[0].startsWith(prefix) && typeof e[1] === 'string'));

/** What must stay on this machine in a sandbox: GitHub, the fakes, and where its operations module sends backups and telemetry. */
function checkLoopback(env: Record<string, string | undefined>): void {
	const must = ['FAKE_GITHUB_URL', 'GRANARY_GITHUB_API_URL', 'GRANARY_GITHUB_WEB_URL'];
	const ifSet = ['FAKE_INFRA_URL', 'LOADGEN_URL', 'GRANARY_SEED_R2_ENDPOINT_OVERRIDE', 'GRANARY_SEED_OTLP_ENDPOINT'];
	for (const k of [...must, ...ifSet.filter((k) => env[k])]) {
		const v = env[k];
		if (!v || !isLoopbackUrl(v)) throw new CliError(`${k} must be a URL on this machine in a sandbox (got ${JSON.stringify(v ?? null)})`);
	}
	if (env.GRANARY_SEED_R2_BUCKET && !env.GRANARY_SEED_R2_ENDPOINT_OVERRIDE) {
		throw new CliError('GRANARY_SEED_R2_BUCKET without GRANARY_SEED_R2_ENDPOINT_OVERRIDE would back the sandbox up to the real R2; point it at fake-infra');
	}
}

export async function sandboxServe(ctx: Context, p: Parsed): Promise<number> {
	explicitDataDir(ctx, p);
	if (!isSandboxDir(ctx.dataDir)) throw new CliError(`${ctx.dataDir} is not a sandbox data dir; create one with \`granary sandbox init --data <dir>\``, EXIT.dataDir);
	const env: Record<string, string | undefined> = { ...ctx.envFileVars, ...process.env };
	if (env.GRANARY_SANDBOX !== '1') throw new CliError(`GRANARY_SANDBOX=1 is missing from ${ctx.envFile}; run \`granary sandbox init --data ${ctx.dataDir}\` again`);
	env.FAKE_GITHUB_PORT ??= SANDBOX_DEFAULTS.githubPort;
	env.FAKE_GITHUB_URL ??= `http://localhost:${env.FAKE_GITHUB_PORT}`;
	checkLoopback(env);

	const base = { PATH: process.env.PATH ?? '' };
	const services: Service[] = [
		{
			name: 'the fake GitHub',
			bundle: 'fake-github.js',
			source: 'fake-github/server.ts',
			url: env.FAKE_GITHUB_URL,
			health: '/healthz',
			env: { ...base, FAKE_GITHUB_HOST: '127.0.0.1', ...pick(env, 'FAKE_GITHUB_') }
		}
	];
	// The rest of the dev simulation (ADR 0315), where `sandbox init` configured it.
	if (env.FAKE_INFRA_URL) {
		services.push({ name: 'fake-infra', bundle: 'fake-infra.js', source: 'fake-infra/server.ts', url: env.FAKE_INFRA_URL, health: '/healthz', env: { ...base, FAKE_INFRA_HOST: '127.0.0.1', ...pick(env, 'FAKE_INFRA_') } });
	}
	if (env.LOADGEN_URL) {
		services.push({
			name: 'the load generator',
			bundle: 'loadgen.js',
			source: 'loadgen/server.ts',
			url: env.LOADGEN_URL,
			health: '/api/status',
			env: { ...base, LOADGEN_HOST: '127.0.0.1', ...pick(env, 'LOADGEN_'), FAKE_GITHUB_URL: env.FAKE_GITHUB_URL }
		});
	}

	let stopping = false;
	const children: Subprocess[] = [];
	process.on('exit', () => {
		for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
	});
	// The server's own handlers shut it down gracefully; the fakes go with the process.
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => (stopping = true));
	for (const s of services) {
		const child = Bun.spawn([process.execPath, findEntry(s)], { env: s.env, stdout: 'inherit', stderr: 'inherit' });
		children.push(child);
		// The sandbox is no use without its simulation: when one ends on its own, so does the sandbox (systemd restarts them all).
		void child.exited.then((code) => {
			if (stopping) return;
			console.error(`granary sandbox: ${s.name} exited (${code}); stopping`);
			process.exit(1);
		});
		await waitHealthy(s, child);
		console.error(`granary sandbox: ${s.name} up at ${s.url} (pid ${child.pid})`);
	}
	return serve(ctx, p, { sandbox: true });
}
