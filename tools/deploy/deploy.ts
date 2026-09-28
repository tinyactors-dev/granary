/**
 * Deploy granary to a host installed the documented way (docs/manual/install.md):
 * Bun and the package under /opt/bun, systemd unit `granary.service`, data in
 * /var/lib/granary. ADR 0233.
 *
 *   mise run deploy -- --host ta-granary.exe.xyz                 # pack HEAD (dev channel), install, restart
 *   mise run deploy -- --host … --channel latest                 # pack HEAD for the latest channel
 *   mise run deploy -- --host … --tarball release/<file>.tgz     # install an existing tarball (e.g. roll back)
 *   mise run deploy -- --host … --npm @dev | --npm 0.1.0         # install from the npm registry
 *   mise run deploy -- --host … --dry-run                        # preflight and plan only; changes nothing
 *
 * Steps: preflight over SSH (refuses unless the documented layout is there and
 * sudo works without a password) → pack HEAD (clean tree required) unless
 * --tarball/--npm → copy the tarball under its versioned name (Bun's install
 * cache reuses a tarball at the same path) → `bun add -g --force` → restart the
 * unit → wait until /healthz reports the new version on the host and at ORIGIN
 * → print /readyz → remove the copied tarball.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const PACKAGE = '@tinyactors/granary';

const Args = Type.Object(
	{
		host: Type.String({ minLength: 1, pattern: '^[A-Za-z0-9._@-]+$', description: 'SSH destination, e.g. ta-granary.exe.xyz or user@host' }),
		channel: Type.Union([Type.Literal('dev'), Type.Literal('latest')]),
		tarball: Type.Optional(Type.String({ pattern: '\\.tgz$' })),
		npm: Type.Optional(Type.String({ pattern: '^(@?[A-Za-z0-9._-]+)$', description: 'dist-tag (@dev, @latest) or exact version' })),
		data: Type.String({ pattern: '^/' }),
		bunInstall: Type.String({ pattern: '^/' }),
		service: Type.String({ pattern: '^[A-Za-z0-9_.@-]+$' }),
		timeout: Type.Integer({ minimum: 5, maximum: 600 }),
		dryRun: Type.Boolean()
	},
	{ additionalProperties: false }
);
type Args = Static<typeof Args>;

const USAGE = `usage: mise run deploy -- --host <ssh-host> [--channel dev|latest] [--tarball <file.tgz> | --npm <tag|version>]
                      [--data /var/lib/granary] [--bun-install /opt/bun] [--service granary] [--timeout 60] [--dry-run]`;

function die(msg: string, code = 1): never {
	console.error(`deploy: ${msg}`);
	process.exit(code);
}

function parseArgs(argv: string[]): Args {
	const raw: Record<string, unknown> = { channel: 'dev', data: '/var/lib/granary', bunInstall: '/opt/bun', service: 'granary', timeout: 60, dryRun: false };
	const names: Record<string, string> = { '--host': 'host', '--channel': 'channel', '--tarball': 'tarball', '--npm': 'npm', '--data': 'data', '--bun-install': 'bunInstall', '--service': 'service', '--timeout': 'timeout' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--dry-run') raw.dryRun = true;
		else if (a === '-h' || a === '--help') {
			console.log(USAGE);
			process.exit(0);
		} else if (names[a]) {
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) die(`${a} needs a value\n${USAGE}`, 2);
			raw[names[a]!] = a === '--timeout' ? Number(v) : v;
		} else die(`unknown argument ${a}\n${USAGE}`, 2);
	}
	if (!Value.Check(Args, raw)) {
		const problems = [...Value.Errors(Args, raw)].map((e) => `  ${e.path || '(args)'}: ${e.message}`);
		die(`invalid arguments:\n${problems.join('\n')}\n${USAGE}`, 2);
	}
	if (raw.tarball && raw.npm) die('--tarball and --npm are mutually exclusive', 2);
	return raw as Args;
}

async function run(cmd: string[], opts: { input?: string; cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> {
	const p = Bun.spawn(cmd, { cwd: opts.cwd ?? ROOT, stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : 'ignore', stdout: 'pipe', stderr: 'pipe' });
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	return { code: await p.exited, out, err };
}

const SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
/** Run a bash script on the host (script on stdin, never on argv). */
const remote = (a: Args, script: string) => run([...SSH, a.host, 'bash', '-s'], { input: `set -uo pipefail\n${script}\n` });

interface Remote {
	origin: string | null;
	healthUrl: string;
	version: string | null;
}

async function preflight(a: Args): Promise<Remote> {
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const r = await remote(
		a,
		`
sudo -n true 2>/dev/null || { echo "ERR passwordless sudo is required for the deploy user"; exit 3; }
test -x ${q(a.bunInstall)}/bin/bun || { echo "ERR ${a.bunInstall}/bin/bun not found (install Bun as in docs/manual/install.md)"; exit 3; }
test -x ${q(a.bunInstall)}/bin/granary || { echo "ERR ${a.bunInstall}/bin/granary not found (bun add -g ${PACKAGE} first)"; exit 3; }
systemctl cat ${q(a.service)}.service >/dev/null 2>&1 || { echo "ERR systemd unit ${a.service}.service not found (granary systemd-unit …)"; exit 3; }
sudo -n test -f ${q(a.data)}/granary.env || { echo "ERR ${a.data}/granary.env not found (granary init)"; exit 3; }
env=$(sudo -n grep -E '^(ORIGIN|HOST|PORT)=' ${q(a.data)}/granary.env || true)
origin=$(printf '%s\\n' "$env" | sed -n 's/^ORIGIN=//p' | tail -1)
host=$(printf '%s\\n' "$env" | sed -n 's/^HOST=//p' | tail -1); port=$(printf '%s\\n' "$env" | sed -n 's/^PORT=//p' | tail -1)
case "\${host:-}" in ""|0.0.0.0|::) host=127.0.0.1;; esac
url="http://\${host}:\${port:-3000}/healthz"
echo "ORIGIN $origin"; echo "HEALTH $url"
echo "VERSION $(curl -s --max-time 5 "$url" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')"
`
	);
	const lines = r.out.split('\n');
	const err = lines.find((l) => l.startsWith('ERR '));
	if (r.code !== 0 || err) die(`preflight on ${a.host} failed: ${err ? err.slice(4) : (r.err.trim() || `ssh exited ${r.code}`)}`);
	const field = (k: string) => lines.find((l) => l.startsWith(`${k} `))?.slice(k.length + 1).trim() || null;
	return { origin: field('ORIGIN'), healthUrl: field('HEALTH')!, version: field('VERSION') };
}

async function tarballVersion(file: string): Promise<string> {
	const r = await run(['tar', '-xzOf', file, 'package/package.json']);
	if (r.code !== 0) die(`cannot read package/package.json from ${file}: ${r.err.trim()}`);
	const pkg = JSON.parse(r.out) as { name?: string; version?: string };
	if (pkg.name !== PACKAGE || !pkg.version) die(`${file} is not a ${PACKAGE} package (name ${pkg.name ?? '?'})`);
	return pkg.version;
}

async function packHead(a: Args): Promise<string> {
	const st = await run(['git', 'status', '--porcelain']);
	if (st.out.trim()) die('the working tree is not clean: deploy packs HEAD, so commit or stash first (or pass --tarball)');
	console.log(`deploy: packing HEAD for the ${a.channel} channel…`);
	const p = Bun.spawn(['bun', 'tools/release/release.ts', 'pack', '--channel', a.channel], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
	if ((await p.exited) !== 0) die('release pack failed');
	const meta = JSON.parse(readFileSync(join(ROOT, 'release/meta.json'), 'utf8')) as { tarball: string };
	return join(ROOT, meta.tarball);
}

async function healthVersion(a: Args, url: string, viaHost: boolean): Promise<string | null> {
	if (viaHost) {
		const r = await remote(a, `curl -s --max-time 5 '${url}' | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p'`);
		return r.out.trim() || null;
	}
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		return ((await res.json()) as { version?: string }).version ?? null;
	} catch {
		return null;
	}
}

async function waitFor(a: Args, url: string, viaHost: boolean, want: string): Promise<boolean> {
	const until = Date.now() + a.timeout * 1000;
	while (Date.now() < until) {
		if ((await healthVersion(a, url, viaHost)) === want) return true;
		await Bun.sleep(1000);
	}
	return false;
}

const a = parseArgs(process.argv.slice(2));
const rm = await preflight(a);
console.log(`deploy: ${a.host} runs ${rm.version ?? '(not responding)'} · ORIGIN ${rm.origin ?? '(unset)'} · ${a.service}.service · data ${a.data}`);

let source: { kind: 'tarball'; file: string; version: string } | { kind: 'npm'; spec: string };
if (a.npm) source = { kind: 'npm', spec: a.npm.startsWith('@') ? `${PACKAGE}${a.npm}` : `${PACKAGE}@${a.npm}` };
else if (a.tarball) {
	const file = resolve(a.tarball);
	if (!existsSync(file)) die(`${a.tarball} does not exist`);
	source = { kind: 'tarball', file, version: await tarballVersion(file) };
} else if (a.dryRun) {
	const head = (await run(['git', 'rev-parse', '--short=7', 'HEAD'])).out.trim();
	const dirty = (await run(['git', 'status', '--porcelain'])).out.trim() !== '';
	if (dirty) console.log('deploy: note: the working tree is not clean; a real run would refuse (deploy packs HEAD)');
	source = { kind: 'tarball', file: `tinyactors-granary-<${a.channel} version of ${head}>.tgz`, version: `packed from HEAD ${head} at deploy time` };
} else {
	const file = await packHead(a);
	source = { kind: 'tarball', file, version: await tarballVersion(file) };
}

const remoteTgz = source.kind === 'tarball' ? `/tmp/${basename(source.file)}` : null;
const installArg = source.kind === 'tarball' ? remoteTgz! : source.spec;
console.log(
	[
		'deploy: plan',
		`  install  ${source.kind === 'tarball' ? `${basename(source.file)} (version ${source.version})` : source.spec}`,
		...(remoteTgz ? [`  copy     → ${a.host}:${remoteTgz}`] : []),
		`  run      sudo BUN_INSTALL=${a.bunInstall} ${a.bunInstall}/bin/bun add -g --force ${installArg}`,
		`  restart  sudo systemctl restart ${a.service}`,
		`  wait     ${rm.healthUrl}${rm.origin ? ` and ${rm.origin}/healthz` : ''} (up to ${a.timeout}s)`
	].join('\n')
);
if (a.dryRun) {
	console.log('deploy: dry run, nothing changed');
	process.exit(0);
}

if (remoteTgz && source.kind === 'tarball') {
	const cp = await run(['scp', '-q', '-o', 'BatchMode=yes', source.file, `${a.host}:${remoteTgz}`]);
	if (cp.code !== 0) die(`copy failed: ${cp.err.trim()}`);
}
const install = await remote(
	a,
	`trap ${remoteTgz ? `'rm -f ${remoteTgz}'` : `''`} EXIT
sudo -n env BUN_INSTALL='${a.bunInstall}' '${a.bunInstall}/bin/bun' add -g --force '${installArg}' >/tmp/granary-deploy.log 2>&1 || { tail -5 /tmp/granary-deploy.log; exit 1; }
'${a.bunInstall}/bin/granary' version | head -1 | sed 's/^granary //'`
);
if (install.code !== 0) die(`install failed on ${a.host}:\n${install.out}${install.err}`);
const installed = install.out.trim().split('\n').pop()!;
if (source.kind === 'tarball' && installed !== source.version) die(`installed ${installed}, expected ${source.version} (stale Bun cache?)`);
console.log(`deploy: installed ${installed}; restarting ${a.service}…`);

const restart = await remote(a, `sudo -n systemctl restart '${a.service}'`);
if (restart.code !== 0) die(`restart failed: ${restart.err.trim()}`);
if (!(await waitFor(a, rm.healthUrl, true, installed))) die(`${rm.healthUrl} did not report ${installed} within ${a.timeout}s (journalctl -u ${a.service})`);
console.log(`deploy: ${a.host} reports ${installed}`);
if (rm.origin) {
	const pub = `${rm.origin.replace(/\/+$/, '')}/healthz`;
	if (!(await waitFor(a, pub, false, installed))) die(`${pub} did not report ${installed} within ${a.timeout}s (proxy/DNS?)`);
	console.log(`deploy: ${pub} reports ${installed}`);
}
const ready = await remote(a, `curl -s --max-time 5 '${rm.healthUrl.replace(/\/healthz$/, '/readyz')}'`);
console.log(`deploy: readyz ${ready.out.trim()}`);
console.log(`deploy: done (was ${rm.version ?? 'not responding'}, now ${installed})`);
