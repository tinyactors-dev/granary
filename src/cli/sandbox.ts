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
 * - the app and the fake listen on 127.0.0.1 only: reach them through an SSH
 *   tunnel. The fake never talks to github.com.
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

export const SANDBOX_DEFAULTS = { port: '3100', githubPort: '4010', dataDir: '/var/lib/granary-sandbox' } as const;

export const isSandboxDir = (dataDir: string): boolean => existsSync(join(dataDir, DATA_DIR_LAYOUT.sandboxMarker));

const port = (v: unknown, fallback: string, what: string): string => {
	const s = typeof v === 'string' ? v : fallback;
	if (!/^[0-9]{2,5}$/.test(s) || Number(s) > 65535) throw new CliError(`--${what} must be a port number (got ${s})`, EXIT.usage);
	return s;
};

/** The sandbox's granary.env. Everything in it is about this machine only. */
function sandboxEnv(o: { port: string; githubPort: string; admins: string }): string {
	const gh = `http://localhost:${o.githubPort}`;
	return `# granary SANDBOX (ADR 0312) — written by \`granary sandbox init\`.
# GitHub here is the fake GitHub, started by \`granary sandbox serve\` on this machine.
# Reach it through an SSH tunnel (both ports, so the fake's sign-in page works too):
#   ssh -L ${o.port}:127.0.0.1:${o.port} -L ${o.githubPort}:127.0.0.1:${o.githubPort} <this host>
# then open http://localhost:${o.port}.
GRANARY_SANDBOX=1
# Development mode: "log in as" under /admin/sessions and the fake GitHub's controls under /admin.
GRANARY_DEV=1
HOST=127.0.0.1
PORT=${o.port}
ORIGIN=http://localhost:${o.port}
GRANARY_GITHUB_API_URL=${gh}
GRANARY_GITHUB_WEB_URL=${gh}
GRANARY_DEV_GITHUB_AUTOCONNECT=1
FAKE_GITHUB_URL=${gh}
FAKE_GITHUB_PORT=${o.githubPort}
FAKE_GITHUB_HOST=127.0.0.1
GRANARY_SEED_ADMINS=${o.admins}
`;
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
	if (appPort === githubPort) throw new CliError('--port and --github-port must differ', EXIT.usage);
	const admins = typeof p.options.admins === 'string' && p.options.admins.trim() ? p.options.admins.trim() : 'admin';
	if (!/^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$/.test(admins)) throw new CliError('--admins is a comma-separated list of logins', EXIT.usage);

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
	writeFileSync(ctx.envFile, sandboxEnv({ port: appPort, githubPort, admins }), { mode: 0o600 });
	chmodSync(ctx.envFile, 0o600);
	lines.push(
		`env file: ${ctx.envFile} (app on 127.0.0.1:${appPort}, fake GitHub on 127.0.0.1:${githubPort})`,
		'',
		'Next:',
		`  granary sandbox serve --data ${d}        (or: granary systemd-unit --unit sandbox --data ${d})`,
		`  ssh -L ${appPort}:127.0.0.1:${appPort} -L ${githubPort}:127.0.0.1:${githubPort} <this host>`,
		`  open http://localhost:${appPort}/admin/sessions and log in as ${admins.split(',')[0]}`
	);
	if (ctx.json) console.log(JSON.stringify({ dataDir: d, port: appPort, githubPort, admins: admins.split(','), envFile: ctx.envFile }, null, 2));
	else console.log(lines.join('\n'));
	return EXIT.ok;
}

/** The fake GitHub's entry: `<pkg>/dist/fake-github.js` next to `dist/cli.js`, or the repository's source. */
export function findFakeGithubEntry(): string {
	const here = dirname(new URL(import.meta.url).pathname);
	const candidates = [resolve(here, 'fake-github.js'), resolve(here, '../../fake-github/server.ts'), resolve(here, '../fake-github/server.ts')];
	const found = candidates.find((c) => existsSync(c));
	if (!found) throw new CliError(`cannot find the fake GitHub (looked at ${candidates.join(', ')}); in the repository run \`mise run cli\``);
	return found;
}

async function waitHealthy(url: string, child: Subprocess, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new CliError(`the fake GitHub exited (${child.exitCode ?? child.signalCode}) before it was ready`);
		try {
			if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return;
		} catch {
			/* not yet */
		}
		await Bun.sleep(150);
	}
	throw new CliError(`the fake GitHub did not answer at ${url}/healthz within ${timeoutMs / 1000} s`);
}

export async function sandboxServe(ctx: Context, p: Parsed): Promise<number> {
	explicitDataDir(ctx, p);
	if (!isSandboxDir(ctx.dataDir)) throw new CliError(`${ctx.dataDir} is not a sandbox data dir; create one with \`granary sandbox init --data <dir>\``, EXIT.dataDir);
	const env = { ...ctx.envFileVars, ...process.env };
	if (env.GRANARY_SANDBOX !== '1') throw new CliError(`GRANARY_SANDBOX=1 is missing from ${ctx.envFile}; run \`granary sandbox init --data ${ctx.dataDir}\` again`);
	const githubPort = env.FAKE_GITHUB_PORT ?? SANDBOX_DEFAULTS.githubPort;
	const githubUrl = env.FAKE_GITHUB_URL ?? `http://localhost:${githubPort}`;
	for (const [k, v] of [['FAKE_GITHUB_URL', githubUrl], ['GRANARY_GITHUB_API_URL', env.GRANARY_GITHUB_API_URL], ['GRANARY_GITHUB_WEB_URL', env.GRANARY_GITHUB_WEB_URL]] as const) {
		if (!v || !isLoopbackUrl(v)) throw new CliError(`${k} must be a URL on this machine in a sandbox (got ${JSON.stringify(v ?? null)})`);
	}

	const entry = findFakeGithubEntry();
	const child = Bun.spawn([process.execPath, entry], {
		env: { PATH: process.env.PATH ?? '', FAKE_GITHUB_PORT: githubPort, FAKE_GITHUB_URL: githubUrl, FAKE_GITHUB_HOST: env.FAKE_GITHUB_HOST ?? '127.0.0.1' },
		stdout: 'inherit',
		stderr: 'inherit'
	});
	let stopping = false;
	process.on('exit', () => {
		if (child.exitCode === null) child.kill('SIGTERM');
	});
	// The server's own handlers shut it down gracefully; the fake goes with the process.
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => (stopping = true));
	// The sandbox is no use without its GitHub: when the fake ends on its own, so does the sandbox (systemd restarts both).
	void child.exited.then((code) => {
		if (stopping) return;
		console.error(`granary sandbox: the fake GitHub exited (${code}); stopping`);
		process.exit(1);
	});
	await waitHealthy(githubUrl, child);
	console.error(`granary sandbox: fake GitHub up at ${githubUrl} (pid ${child.pid})`);
	return serve(ctx, p, { sandbox: true });
}
