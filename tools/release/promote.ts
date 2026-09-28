/**
 * release:promote (ADR 0188): point the `latest` dist-tag at an existing,
 * stable version (e.g. to roll back, or to repair a mis-tagged publish).
 *
 *   fnox exec -P release -- bun tools/release/promote.ts <version> [--yes]
 *
 * Refuses prereleases and versions that are not on the registry. Dry run
 * unless --yes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_DEFAULTS, die, isPrerelease, npmCmd, npmView } from './common';

const [version] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const really = process.argv.includes('--yes');
if (!version) die('usage: release:promote <version> [--yes]');
if (isPrerelease(version)) die(`${version} is a prerelease — "latest" must always be a stable version`);
const exists = await npmView<string>(`${RELEASE_DEFAULTS.name}@${version}`, 'version');
if (exists !== version) die(`${RELEASE_DEFAULTS.name}@${version} is not on the registry`);
const tags = await npmView<Record<string, string>>(RELEASE_DEFAULTS.name, 'dist-tags');
console.log(`dist-tags now: ${JSON.stringify(tags ?? {})}`);
if (tags?.latest === version) {
	console.log(`latest already points at ${version}`);
	process.exit(0);
}
if (!really) {
	console.log(`dry run: would set ${RELEASE_DEFAULTS.name} latest → ${version} (re-run with --yes)`);
	process.exit(0);
}
if (!process.env.NPM_TOKEN) die('NPM_TOKEN is not set — run through `mise run release:promote` (fnox profile "release")');
const dir = await mkdtemp(join(tmpdir(), 'granary-npmrc-'));
const npmrc = join(dir, 'npmrc');
await Bun.write(npmrc, `${RELEASE_DEFAULTS.registry.replace(/^https?:/, '').replace(/\/?$/, '/')}:_authToken=\${NPM_TOKEN}\n`);
const p = Bun.spawn([...(await npmCmd()), 'dist-tag', 'add', `${RELEASE_DEFAULTS.name}@${version}`, 'latest', '--registry', RELEASE_DEFAULTS.registry, '--userconfig', npmrc], { stdout: 'inherit', stderr: 'inherit' });
const code = await p.exited;
await rm(dir, { recursive: true, force: true });
if (code !== 0) die(`npm dist-tag exited ${code}`, code);
console.log(`latest → ${version}`);
