/**
 * Shared bits of the release tooling (ADR 0180–0183).
 * Defaults that still await confirmation live in RELEASE_DEFAULTS so they are
 * trivial to change in one place.
 */
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '../..');
export const RELEASE_DIR = join(ROOT, 'release');
export const WORK_DIR = join(RELEASE_DIR, 'work');
export const STAGE_DIR = join(RELEASE_DIR, 'package');
export const META_FILE = join(RELEASE_DIR, 'meta.json');
export const VERIFY_FILE = join(RELEASE_DIR, 'verify.json');

/** Pending user confirmation (see ADR 0180); change here only. */
export const RELEASE_DEFAULTS = {
	name: '@tinyactors/granary',
	license: 'MIT',
	author: 'Dario Hamidi',
	repository: 'https://github.com/tinyactors/granary',
	homepage: 'https://github.com/tinyactors/granary#readme',
	registry: 'https://registry.npmjs.org/',
	access: 'public' as const,
	/** Provenance needs an OIDC-capable CI (ADR 0183); local publishes skip it. */
	provenance: false,
	bunEngine: '>=1.4.1',
	/** Docker platforms release:verify checks (ADR 0181). */
	platforms: ['linux/arm64', 'linux/amd64'] as const
};

export interface PackMeta {
	name: string;
	version: string;
	gitSha: string;
	source: 'git' | 'working-tree';
	dirty: boolean;
	builtAt: string;
	tarball: string;
	sha256: string;
	cliPlaceholder: boolean;
	dependencies: Record<string, string>;
}

export interface VerifyResult {
	platform: string;
	ok: boolean;
	steps: { name: string; ok: boolean; missing?: boolean; detail: string }[];
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
