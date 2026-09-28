/**
 * Shared bits of the release tooling (ADR 0180–0188).
 * Package identity lives in RELEASE_DEFAULTS (confirmed by the user, ADR 0187).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const ROOT = resolve(import.meta.dir, '../..');
export const RELEASE_DIR = join(ROOT, 'release');
/**
 * The exported source is built OUTSIDE the repository: nested inside the
 * checkout, the build's tsconfig resolution reached the outer checkout's
 * generated `.svelte-kit/`, so packs passed on a dev machine and failed on a
 * fresh clone / CI (ADR 0189).
 */
export const WORK_DIR = join(tmpdir(), 'granary-release-work');
export const STAGE_DIR = join(RELEASE_DIR, 'package');
export const META_FILE = join(RELEASE_DIR, 'meta.json');
export const VERIFY_FILE = join(RELEASE_DIR, 'verify.json');

/** The one Bun version the project is built, verified and released with (`.bun-version`). */
export const BUN_VERSION = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();

/** Package identity (ADR 0187). */
export const RELEASE_DEFAULTS = {
	name: '@tinyactors/granary',
	license: 'MIT',
	author: 'Dario Hamidi',
	repository: 'https://github.com/tinyactors-dev/granary',
	homepage: 'https://github.com/tinyactors-dev/granary#readme',
	registry: 'https://registry.npmjs.org/',
	access: 'public' as const,
	bunEngine: `>=${BUN_VERSION}`,
	/** Docker platforms release:verify checks (ADR 0181). */
	platforms: ['linux/arm64', 'linux/amd64'] as const
};

/** Release channels = npm dist-tags (ADR 0185). */
export type Channel = 'dev' | 'latest';
export const CHANNELS: readonly Channel[] = ['dev', 'latest'];

export interface PackMeta {
	name: string;
	version: string;
	/** The channel the version was computed for (absent in packs made before ADR 0185). */
	channel?: Channel;
	gitSha: string;
	source: 'git' | 'working-tree';
	dirty: boolean;
	builtAt: string;
	tarball: string;
	sha256: string;
	dependencies: Record<string, string>;
}

export interface VerifyResult {
	platform: string;
	ok: boolean;
	/** Not run on this host (e.g. emulated x86-64, ADR 0184); publish needs --accept-unverified. */
	skipped?: string;
	steps: { name: string; ok: boolean; detail: string }[];
}
export interface VerifyReport {
	tarball: string;
	sha256: string;
	gitSha: string;
	at: string;
	ok: boolean;
	results: VerifyResult[];
}

export function die(msg: string, code = 1): never {
	console.error(`release: ${msg}`);
	process.exit(code);
}

export async function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; quiet?: boolean } = {}): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(cmd, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, stdout: 'pipe', stderr: 'pipe' });
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const code = await p.exited;
	if (!opts.quiet && code !== 0) process.stderr.write(err);
	return { code, out: out + (code !== 0 ? err : '') };
}

export async function mustSh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<string> {
	const r = await sh(cmd, opts);
	if (r.code !== 0) die(`command failed (${r.code}): ${cmd.join(' ')}\n${r.out.slice(-2000)}`);
	return r.out;
}

export async function readJson<T>(path: string): Promise<T | null> {
	const f = Bun.file(path);
	return (await f.exists()) ? ((await f.json()) as T) : null;
}

export async function sha256File(path: string): Promise<string> {
	const h = new Bun.CryptoHasher('sha256');
	h.update(await Bun.file(path).arrayBuffer());
	return h.digest('hex');
}

export async function rootVersion(): Promise<string> {
	const pkg = (await Bun.file(join(ROOT, 'package.json')).json()) as { version?: string };
	if (!pkg.version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) die('package.json has no valid "version" (SemVer)');
	return pkg.version;
}

/** A SemVer with a prerelease part (`1.2.3-dev.…`) must never become `latest` (ADR 0188). */
export const isPrerelease = (v: string) => /^\d+\.\d+\.\d+-/.test(v);

export function bumpPatch(v: string): string {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
	if (!m) die(`not a SemVer: ${v}`);
	return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * The dev version for HEAD (ADR 0185): `<base>-dev.<unix epoch>.g<short sha>`.
 * `base` is package.json's version, or its next patch once that version is
 * published as stable, so dev builds always sort above the latest release.
 * The `g` keeps the identifier alphanumeric (an all-digit sha with a leading
 * zero would be an invalid SemVer numeric identifier), as in `git describe`.
 */
export function devVersion(base: string, gitSha: string, epochSeconds = Math.floor(Date.now() / 1000)): string {
	return `${base}-dev.${epochSeconds}.g${gitSha.slice(0, 7)}`;
}

/** The npm CLI to use: `npm` on PATH (Node's, needed for provenance in CI), else `bunx npm@latest`. */
export async function npmCmd(): Promise<string[]> {
	const which = await sh(['sh', '-c', 'command -v npm'], { quiet: true });
	return which.code === 0 && which.out.trim() ? ['npm'] : ['bunx', 'npm@latest'];
}

/** `npm view` as JSON; null when the package/version does not exist (or the registry is unreachable). */
export async function npmView<T>(spec: string, field: string): Promise<T | null> {
	const r = await sh([...(await npmCmd()), 'view', spec, field, '--json', '--registry', RELEASE_DEFAULTS.registry], { quiet: true });
	if (r.code !== 0 || !r.out.trim()) return null;
	try {
		return JSON.parse(r.out) as T;
	} catch {
		return null;
	}
}

export const isGitHubActions = () => process.env.GITHUB_ACTIONS === 'true';
export const hasOidc = () => Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

/**
 * All verify results for one tarball, merged by platform (ADR 0186): the local
 * `release/verify.json` plus `release/verify-*.json` from CI verify jobs.
 * Later files win per platform; files for other tarballs are ignored.
 */
export async function loadVerify(sha256: string): Promise<VerifyReport | null> {
	const { readdir } = await import('node:fs/promises');
	const files = (await readdir(RELEASE_DIR).catch(() => [] as string[]))
		.filter((f) => f === 'verify.json' || /^verify-.+\.json$/.test(f))
		.sort();
	let merged: VerifyReport | null = null;
	for (const f of files) {
		const r = await readJson<VerifyReport>(join(RELEASE_DIR, f));
		if (!r || r.sha256 !== sha256) continue;
		if (!merged) merged = { ...r, results: [...r.results] };
		else for (const res of r.results) merged.results = [...merged.results.filter((x) => x.platform !== res.platform), res];
	}
	if (merged) merged.ok = merged.results.some((r) => r.ok) && merged.results.every((r) => r.ok || r.skipped);
	return merged;
}
