/**
 * `granary init`, `granary serve`, `granary restore` (ADR 0157, 0159, 0163).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { DATA_DIR_LAYOUT, EXIT, MIN_BUN_VERSION } from '../lib/schemas/cli';
import { MASTER_KEY_ENV } from '../lib/platform/secrets/contract';
import { firstEnv, generateMasterKey, kekIdOf, decodeKeyMaterial } from '../lib/platform/secrets/keys';
import { versionAtLeast } from '../lib/server/doctor';
import type { Parsed } from './args';
import { CliError, livePid, parseEnvFile, requireOffline, type Context } from './context';

const ENV_SKELETON = (origin: string | null) => `# granary process settings (ADR 0157). Everything else — the GitHub
# connection, admins, allowlist, backups, telemetry — is configured in the product.
# \`granary serve\` reads this file; it never loads a .env from the working directory.

# Public URL of this instance (needed for sign-in links and the GitHub App webhook).
${origin ? `ORIGIN=${origin}` : '# ORIGIN=https://granary.example.com'}

# Where to listen (defaults: 0.0.0.0:3000).
# HOST=0.0.0.0
# PORT=3000

# Behind a TLS-terminating reverse proxy:
# PROTOCOL_HEADER=x-forwarded-proto
# HOST_HEADER=x-forwarded-host

# Optional seeds, applied once when the in-product value is absent:
# GRANARY_ADMINS=your-github-login
`;

async function confirmKey(key: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		for (let i = 0; i < 3; i++) {
			const typed = (await rl.question('Type the last 6 characters of the key to confirm you stored it: ')).trim();
			if (typed === key.slice(-6)) return true;
			console.error('That does not match. Copy the key into your password manager first.');
		}
		return false;
	} finally {
		rl.close();
	}
}

export async function init(ctx: Context, p: Parsed): Promise<number> {
	await requireOffline(ctx, '`granary init`');
	const origin = typeof p.options.origin === 'string' ? p.options.origin.replace(/\/+$/, '') : null;
	if (origin && !/^https?:\/\/\S+$/.test(origin)) throw new CliError(`--origin must be a URL like https://granary.example.com (got ${origin})`, EXIT.usage);
	mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
	chmodSync(ctx.dataDir, 0o700);
	const keyFile = join(ctx.dataDir, DATA_DIR_LAYOUT.masterKey);
	const fromEnv = firstEnv(process.env, MASTER_KEY_ENV.current);
	const lines: string[] = [`data dir: ${ctx.dataDir} (mode 700)`];
	const result: { dataDir: string; masterKey: string | null; masterKeySource: 'generated' | 'file' | 'env'; masterKeyFile: string | null; kekId: string; envFile: string } = {
		dataDir: ctx.dataDir,
		masterKey: null,
		masterKeySource: 'env',
		masterKeyFile: null,
		kekId: '',
		envFile: ctx.envFile
	};

	if (fromEnv) {
		result.kekId = kekIdOf(decodeKeyMaterial(fromEnv[1], fromEnv[0]));
		lines.push(`master key: from ${fromEnv[0]} (no master.key written)`);
	} else if (existsSync(keyFile)) {
		const raw = decodeKeyMaterial(readFileSync(keyFile, 'utf8'), keyFile);
		Object.assign(result, { masterKeySource: 'file', masterKeyFile: keyFile, kekId: kekIdOf(raw) });
		lines.push(`master key: ${keyFile} already exists (kek ${kekIdOf(raw)}); not regenerated`);
	} else {
		if (ctx.json && p.options['yes-i-stored-the-key'] !== true)
			throw new CliError('`granary init --json` prints the new key only in its JSON output: pass --yes-i-stored-the-key and store the key from that output', EXIT.usage);
		if (p.options['yes-i-stored-the-key'] !== true && !process.stdin.isTTY)
			throw new CliError('not a terminal: `granary init` must show you the new master key and have you confirm it; run it interactively, or pass --yes-i-stored-the-key and store the key it prints', EXIT.usage);
		const key = generateMasterKey();
		const bar = '─'.repeat(64);
		// --json: the key goes into the JSON on stdout (shown once there); otherwise to the terminal.
		if (!ctx.json) console.error(
			[
				bar,
				'granary master key — shown ONCE. Store it in your password manager now.',
				'It encrypts stored secrets and every off-site backup. Without it,',
				'secrets and backups cannot be decrypted, ever.',
				'',
				`  ${key}`,
				'',
				'To use it from env instead of the file: GRANARY_MASTER_KEY=<key>',
				bar
			].join('\n')
		);
		const ok = p.options['yes-i-stored-the-key'] === true || (await confirmKey(key));
		if (!ok)
			throw new CliError(
				process.stdin.isTTY
					? 'key not confirmed; nothing was written. Run `granary init` again.'
					: 'not a terminal: pass --yes-i-stored-the-key after storing the key printed above (nothing was written)',
				EXIT.usage
			);
		writeFileSync(keyFile, key + '\n', { mode: 0o600 });
		chmodSync(keyFile, 0o600);
		Object.assign(result, { masterKey: key, masterKeySource: 'generated', masterKeyFile: keyFile, kekId: kekIdOf(decodeKeyMaterial(key, 'key')) });
		lines.push(`master key: written to ${keyFile} (mode 600, kek ${result.kekId})`);
	}

	if (!existsSync(ctx.envFile)) {
		writeFileSync(ctx.envFile, ENV_SKELETON(origin), { mode: 0o600 });
		chmodSync(ctx.envFile, 0o600);
		lines.push(`env file: ${ctx.envFile} (edit ORIGIN/PORT there)`);
	} else {
		lines.push(`env file: ${ctx.envFile} kept${origin ? ' (--origin ignored: edit ORIGIN there)' : ''}`);
	}
	const d = ctx.dataDir;
	lines.push(
		'',
		'Next:',
		`  granary admin add <your-github-login> --data ${d}`,
		`  granary serve --data ${d}                 (or: granary systemd-unit --data ${d})`,
		`  granary login-link <your-github-login> --data ${d}`,
		'  then open the link and connect GitHub under Settings → GitHub.'
	);
	if (ctx.json) console.log(JSON.stringify(result, null, 2));
	else console.log(lines.join('\n'));
	return EXIT.ok;
}

/** The SvelteKit server entry: `<pkg>/build/index.js` next to `dist/cli.js`, or the repo's `build/`. */
export function findServerEntry(): string {
	const here = dirname(new URL(import.meta.url).pathname);
	const candidates = [
		process.env.GRANARY_BUILD_DIR ? join(process.env.GRANARY_BUILD_DIR, 'index.js') : null,
		resolve(here, '../build/index.js'),
		resolve(here, '../../build/index.js')
	].filter((x): x is string => !!x);
	const found = candidates.find((c) => existsSync(c));
	if (!found) throw new CliError(`cannot find the server build (looked at ${candidates.join(', ')}); in the repository run \`mise run build\``);
	return found;
}

/** Env files Bun would have auto-loaded from the working directory. */
const AUTO_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local'];

export async function serve(ctx: Context, p: Parsed): Promise<number> {
	if (!versionAtLeast(Bun.version, MIN_BUN_VERSION)) throw new CliError(`granary needs Bun ≥ ${MIN_BUN_VERSION} (this is ${Bun.version})`);
	const pid = livePid(ctx);
	if (pid !== null && pid !== process.pid) throw new CliError(`granary is already running for ${ctx.dataDir} (pid ${pid})`);
	if (!existsSync(ctx.dataDir)) throw new CliError(`${ctx.dataDir} does not exist; run \`granary init --data ${ctx.dataDir}\` first`);
	const mode = statSync(ctx.dataDir).mode & 0o777;
	if (mode & 0o077) console.error(`warning: ${ctx.dataDir} is mode ${mode.toString(8)}; granary tightens it to 700`);

	// ADR 0157: never pick up a .env from the working directory. Bun auto-loads
	// those into process.env before we run, so drop what came from them (unless
	// the same value is also in granary.env or the data dir *is* the cwd).
	if (resolve(process.cwd()) !== ctx.dataDir) {
		const dropped: string[] = [];
		for (const f of AUTO_ENV_FILES) {
			if (!existsSync(f)) continue;
			for (const [k, v] of Object.entries(parseEnvFile(readFileSync(f, 'utf8')))) {
				if (process.env[k] === v && ctx.envFileVars[k] !== v) {
					delete process.env[k];
					dropped.push(k);
				}
			}
		}
		if (dropped.length) console.error(`granary serve: ignored ${dropped.length} variable(s) from .env files in ${process.cwd()} (use ${ctx.envFile})`);
	}
	// <data>/granary.env, then flags; the real process env wins over the file.
	for (const [k, v] of Object.entries(ctx.envFileVars)) if (process.env[k] === undefined) process.env[k] = v;
	process.env.GRANARY_DATA_DIR = ctx.dataDir;
	if (typeof p.options.host === 'string') process.env.HOST = p.options.host;
	if (typeof p.options.port === 'string') process.env.PORT = p.options.port;
	process.env.NODE_ENV ??= 'production';
	if (!process.env.ORIGIN) console.error('warning: ORIGIN is not set; set it in granary.env (sign-in links and the GitHub App need the public URL)');

	const entry = findServerEntry();
	await import(pathToFileURL(entry).href);
	return -1; // keep running
}

const RESTORE_HELP = `granary restore — restore a backup to a file (ADR 0115). Refuses while granary runs.

Config mode (the data dir still has ops.sqlite; --ops-db defaults to <data>/ops.sqlite):
  granary restore --dest <destination-id> [--database granary] [--run <runId> | --latest] --out restored.sqlite
Direct mode (disaster recovery: only the master key + bucket credentials):
  granary restore --r2-account <id> [--jurisdiction eu] --bucket <b> [--prefix granary/] --access-key-id <id> --out …
  granary restore --endpoint https://… [--region auto] --bucket <b> [--prefix granary/] --access-key-id <id> --out …
  (secret access key from env OPS_RESTORE_SECRET_ACCESS_KEY)
Options: --list (list committed backups), --force (overwrite --out), --json, --data <dir>
Master key: GRANARY_MASTER_KEY (and GRANARY_MASTER_KEY_PREVIOUS for older backups) or <data>/master.key.
The restored file is verified (checksums, PRAGMA integrity_check, row counts); exit 0 only when all match.`;

export async function restore(ctx: Context, p: Parsed): Promise<number> {
	if (p.rest.includes('--help') || p.rest.includes('-h')) {
		console.log(RESTORE_HELP);
		return EXIT.ok;
	}
	await requireOffline(ctx, '`granary restore`');
	const rest = [...p.rest];
	const direct = rest.some((a) => a === '--r2-account' || a.startsWith('--r2-account=') || a === '--endpoint' || a.startsWith('--endpoint='));
	const hasOpsDb = rest.some((a) => a === '--ops-db' || a.startsWith('--ops-db='));
	if (!direct && !hasOpsDb && !rest.includes('--help') && !rest.includes('-h')) rest.unshift('--ops-db', join(ctx.dataDir, DATA_DIR_LAYOUT.opsDatabase));
	process.env.GRANARY_DATA_DIR = ctx.dataDir;
	for (const [k, v] of Object.entries(ctx.envFileVars)) if (process.env[k] === undefined) process.env[k] = v;
	process.argv = [process.argv[0]!, 'granary restore', ...rest];
	await import('../lib/ops/cli/restore');
	return -1; // restore exits itself
}
