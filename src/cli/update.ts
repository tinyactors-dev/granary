/**
 * `granary update` (ADR 0301, ADR 0302): bring this host to the newest
 * version of a channel, the way `mise run deploy` does from a laptop
 * (ADR 0233), but pulled by the host itself. A systemd timer runs it as root
 * (`granary systemd-unit --unit update-timer`).
 *
 * Channels:
 * - `latest`, `dev`: the npm dist-tag (a version still in npm's review is not
 *   tagged yet, so it waits for a later run);
 * - `edge`: the rolling GitHub prerelease `edge`, which CI replaces on every
 *   green push to main with the verified tarball and its SHA256SUMS; read
 *   from release download URLs (not the rate-limited API) and checked
 *   against the hash.
 *
 * 1. the running version is what `/healthz` reports (HOST/PORT from the data
 *    dir's granary.env); equal to the channel's → nothing to do;
 * 2. install under BUN_INSTALL (`bun add -g --force`, from npm or from the
 *    downloaded tarball, kept in the cache dir under its versioned name),
 *    `systemctl restart <service>`, then wait until `/healthz` reports it;
 * 3. if it does not within the timeout, reinstall the version that ran
 *    before (its cached tarball, else npm), restart, and fail.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Parsed } from './args';
import { CliError, print, type Context } from './context';
import { EXIT } from '../lib/schemas/cli';
import { VERSION } from '../lib/version';

const PACKAGE = '@tinyactors/granary';
const REGISTRY = 'https://registry.npmjs.org';
const EDGE = 'https://github.com/tinyactors-dev/granary/releases/download/edge';
/** Tarballs kept in the cache dir, newest first: enough to roll back. */
const KEEP_TARBALLS = 3;
export const CHANNELS = ['edge', 'dev', 'latest'] as const;

export interface UpdateResult {
	channel: string;
	running: string | null;
	target: string;
	action: 'up-to-date' | 'updated' | 'not-yet-available' | 'planned';
}

interface Release {
	version: string;
	/** Bring the tarball or spec within reach of `bun add -g` (download, check). */
	fetch(): Promise<string>;
}

const tarballName = (version: string) => `tinyactors-granary-${version}.tgz`;

/** The version the npm dist-tag points at; installed by spec. */
async function npmRelease(channel: string): Promise<Release> {
	const res = await fetch(`${REGISTRY}/${PACKAGE.replace('/', '%2f')}`, {
		headers: { accept: 'application/vnd.npm.install-v1+json', 'cache-control': 'no-cache' },
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new CliError(`npm registry: HTTP ${res.status} for ${PACKAGE}`, EXIT.error);
	const tags = ((await res.json()) as { 'dist-tags'?: Record<string, string> })['dist-tags'] ?? {};
	const version = tags[channel];
	if (!version) throw new CliError(`npm has no "${channel}" dist-tag for ${PACKAGE}`, EXIT.error);
	return { version, fetch: async () => `${PACKAGE}@${version}` };
}

/** The edge release: SHA256SUMS names the tarball (and so the version); the download is checked against it. */
async function edgeRelease(cache: string): Promise<Release | null> {
	const sums = await fetch(`${EDGE}/SHA256SUMS`, { signal: AbortSignal.timeout(15_000) });
	// The release is replaced on every push: for a moment it does not exist.
	if (sums.status === 404) return null;
	if (!sums.ok) throw new CliError(`edge release: HTTP ${sums.status} for SHA256SUMS`, EXIT.error);
	const m = /^([0-9a-f]{64})\s+\*?(tinyactors-granary-(\S+)\.tgz)\s*$/m.exec(await sums.text());
	if (!m) throw new CliError('edge release: SHA256SUMS names no granary tarball', EXIT.error);
	const [, sha256, file, version] = m as unknown as [string, string, string, string];
	return {
		version,
		async fetch() {
			const path = join(cache, file);
			if (existsSync(path) && sha256Of(await Bun.file(path).bytes()) === sha256) return path;
			const res = await fetch(`${EDGE}/${file}`, { signal: AbortSignal.timeout(120_000) });
			if (!res.ok) throw new CliError(`edge release: HTTP ${res.status} for ${file}`, EXIT.error);
			const bytes = new Uint8Array(await res.arrayBuffer());
			const got = sha256Of(bytes);
			if (got !== sha256) throw new CliError(`edge release: ${file} has sha256 ${got}, SHA256SUMS says ${sha256}`, EXIT.error);
			mkdirSync(cache, { recursive: true, mode: 0o700 });
			await Bun.write(path, bytes);
			return path;
		}
	};
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Keep the newest KEEP_TARBALLS tarballs of the cache dir. */
function pruneCache(cache: string): void {
	if (!existsSync(cache)) return;
	const files = readdirSync(cache)
		.filter((f) => /^tinyactors-granary-.*\.tgz$/.test(f))
		.map((f) => ({ f, t: statSync(join(cache, f)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	for (const { f } of files.slice(KEEP_TARBALLS)) unlinkSync(join(cache, f));
}

/** `http://<HOST>:<PORT>/healthz` from granary.env (127.0.0.1 for a wildcard or unset HOST). */
function healthURL(env: Record<string, string>): string {
	const host = !env.HOST || env.HOST === '0.0.0.0' || env.HOST === '::' ? '127.0.0.1' : env.HOST;
	return `http://${host.includes(':') ? `[${host}]` : host}:${env.PORT || '3000'}/healthz`;
}

async function runningVersion(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		return ((await res.json()) as { version?: string }).version ?? null;
	} catch {
		return null;
	}
}

async function run(cmd: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	return { code: await p.exited, out: `${out}${err}`.trim() };
}

export async function update(ctx: Context, p: Parsed): Promise<number> {
	const channel = String(p.options.channel ?? 'edge');
	if (!(CHANNELS as readonly string[]).includes(channel)) throw new CliError(`--channel must be one of ${CHANNELS.join(', ')}`, EXIT.usage);
	const bunInstall = String(p.options['bun-install'] ?? '/opt/bun');
	const service = String(p.options.service ?? 'granary');
	const cache = String(p.options.cache ?? '/var/cache/granary-update');
	const timeoutMs = Number(p.options.timeout ?? 60) * 1000;
	const dryRun = p.options['dry-run'] === true;
	const health = healthURL(ctx.envFileVars);

	const release = channel === 'edge' ? await edgeRelease(cache) : await npmRelease(channel);
	const running = await runningVersion(health);
	if (!release) {
		print(ctx, { channel, running, target: null, action: 'not-yet-available' }, () => 'no edge release right now (being replaced, or not created yet); will retry');
		return EXIT.ok;
	}
	const target = release.version;
	const result = (action: UpdateResult['action']): UpdateResult => ({ channel, running, target, action });
	const say = (r: UpdateResult, text: string) => print(ctx, r, () => text);

	if (running === target) {
		say(result('up-to-date'), `granary ${running} is the newest ${channel} version`);
		return EXIT.ok;
	}
	if (dryRun) {
		say(result('planned'), `would update granary ${running ?? '(not responding)'} → ${target} (${channel}), restart ${service}.service, wait for ${health}`);
		return EXIT.ok;
	}
	if (process.getuid?.() !== 0) throw new CliError('granary update installs under BUN_INSTALL and restarts the service: run it as root', EXIT.error);

	const bun = `${bunInstall}/bin/bun`;
	const install = (spec: string) => run([bun, 'add', '-g', '--force', spec], { BUN_INSTALL: bunInstall });
	const restartAndWait = async (version: string): Promise<boolean> => {
		const r = await run(['systemctl', 'restart', `${service}.service`]);
		if (r.code !== 0) {
			console.error(`granary update: systemctl restart ${service} failed: ${r.out}`);
			return false;
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if ((await runningVersion(health)) === version) return true;
			await Bun.sleep(1000);
		}
		return false;
	};

	console.log(`granary update: ${running ?? '(not responding)'} → ${target} (${channel})`);
	const installed = await install(await release.fetch());
	if (installed.code !== 0) {
		// An npm dist-tag can lead its tarball by a moment while npm processes a publish: try again next run.
		if (channel !== 'edge' && /No version matching|failed to resolve|404/i.test(installed.out)) {
			say(result('not-yet-available'), `granary ${target} is not installable yet; will retry\n${installed.out}`);
			return EXIT.ok;
		}
		throw new CliError(`bun add -g ${target} failed:\n${installed.out}`, EXIT.error);
	}
	if (await restartAndWait(target)) {
		pruneCache(cache);
		say(result('updated'), `granary updated to ${target}; ${health} reports it`);
		return EXIT.ok;
	}

	// Roll back to what ran before (or, if nothing answered, to this CLI's own version): its cached tarball, else npm.
	const previous = running ?? VERSION;
	const cached = join(cache, tarballName(previous));
	console.error(`granary update: ${target} did not come up within ${timeoutMs / 1000}s; rolling back to ${previous}`);
	const back = await install(existsSync(cached) ? cached : `${PACKAGE}@${previous}`);
	if (back.code !== 0) throw new CliError(`rollback: bun add -g ${previous} failed:\n${back.out}`, EXIT.error);
	const ok = await restartAndWait(previous);
	throw new CliError(`granary ${target} did not start; ${ok ? `rolled back to ${previous}` : `rollback to ${previous} did not come up either`}`, EXIT.error);
}
