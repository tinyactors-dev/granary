/**
 * release:publish (ADR 0182): publish the verified tarball to npm.
 *
 *   fnox exec -P release -- bun tools/release/publish.ts            # dry run (default)
 *   fnox exec -P release -- bun tools/release/publish.ts --yes      # really publish
 *
 * Never publishes implicitly. Refuses unless ALL hold:
 *   - clean git tree, HEAD tagged `v<version>` (package.json version)
 *   - CHANGELOG.md has a `## [<version>]` entry that is not "unreleased"
 *   - release/meta.json: packed from git (not --working-tree), at HEAD, no
 *     CLI placeholder, tarball present with matching sha256
 *   - release/verify.json: passed for that exact tarball (sha256)
 *   - the version is not already on the registry
 *   - NPM_TOKEN in the environment (from fnox profile `release`) for --yes
 * Provenance: off for laptop publishes (needs CI with OIDC; ADR 0183).
 */
import { join } from 'node:path';
import { META_FILE, RELEASE_DEFAULTS, ROOT, VERIFY_FILE, die, readJson, rootVersion, sh, sha256File, type PackMeta, type VerifyReport } from './common';

const args = process.argv.slice(2);
const really = args.includes('--yes');
const problems: string[] = [];
const check = (cond: unknown, msg: string) => {
	if (!cond) problems.push(msg);
};

const version = await rootVersion();
const head = (await sh(['git', 'rev-parse', 'HEAD'])).out.trim();
const status = (await sh(['git', 'status', '--porcelain'])).out.trim();
check(status === '', 'git tree is not clean (commit or stash first)');
const tags = (await sh(['git', 'tag', '--points-at', 'HEAD'])).out.split('\n').map((t) => t.trim());
check(tags.includes(`v${version}`), `HEAD is not tagged v${version} (git tag -a v${version} -m "granary ${version}")`);

const changelog = await Bun.file(join(ROOT, 'CHANGELOG.md')).text();
const entry = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]\\s*-\\s*(.+)$`, 'm').exec(changelog);
check(entry, `CHANGELOG.md has no "## [${version}] - <date>" entry`);
check(!entry || !/unreleased/i.test(entry[1]!), `CHANGELOG.md entry for ${version} is still marked unreleased — set the release date`);

const meta = await readJson<PackMeta>(META_FILE);
check(meta, 'no release/meta.json — run `mise run release:pack`');
if (meta) {
	check(meta.version === version, `packed version ${meta.version} ≠ package.json ${version} — re-pack`);
	check(meta.source === 'git' && !meta.dirty, 'tarball was packed from the working tree — re-pack from git (`mise run release:pack`)');
	check(meta.gitSha === head, `tarball was packed at ${meta.gitSha.slice(0, 12)}, HEAD is ${head.slice(0, 12)} — re-pack`);
	check(!meta.cliPlaceholder, 'tarball contains the CLI placeholder (--allow-missing-cli) — cannot publish');
	const tgz = join(ROOT, meta.tarball);
	const present = await Bun.file(tgz).exists();
	check(present, `${meta.tarball} is missing`);
	if (present) check((await sha256File(tgz)) === meta.sha256, `${meta.tarball} changed since packing`);
}
const verify = await readJson<VerifyReport>(VERIFY_FILE);
check(verify, 'no release/verify.json — run `mise run release:verify`');
if (verify && meta) {
	check(verify.sha256 === meta.sha256, 'release/verify.json is for a different tarball — run release:verify again');
	check(verify.ok, 'release:verify did not pass for this tarball');
	for (const p of RELEASE_DEFAULTS.platforms) check(verify.results.some((r) => r.platform === p && r.ok), `release:verify has no passing run for ${p}`);
}
const view = await sh(['bunx', 'npm@latest', 'view', `${RELEASE_DEFAULTS.name}@${version}`, 'version', '--registry', RELEASE_DEFAULTS.registry], { quiet: true });
check(!(view.code === 0 && view.out.trim() === version), `${RELEASE_DEFAULTS.name}@${version} is already published — bump the version`);
if (really) check(process.env.NPM_TOKEN, 'NPM_TOKEN is not set — run through `mise run release:publish -- --yes` (fnox profile "release")');

if (problems.length) {
	console.error(`release:publish refused (${problems.length} problem${problems.length > 1 ? 's' : ''}):\n  - ${problems.join('\n  - ')}`);
	process.exit(1);
}

const tgz = join(ROOT, meta!.tarball);
const cmd = ['bun', 'publish', tgz, '--access', RELEASE_DEFAULTS.access, '--registry', RELEASE_DEFAULTS.registry, ...(really ? [] : ['--dry-run'])];
console.log(`${really ? 'PUBLISHING' : 'dry run:'} ${RELEASE_DEFAULTS.name}@${version} (${meta!.gitSha.slice(0, 12)}, sha256 ${meta!.sha256.slice(0, 16)}…)${RELEASE_DEFAULTS.provenance ? ' with provenance' : ' without provenance (ADR 0183)'}`);
const r = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, NPM_CONFIG_TOKEN: process.env.NPM_TOKEN ?? '' }, stdout: 'inherit', stderr: 'inherit' });
const code = await r.exited;
if (code !== 0) die(`bun publish exited ${code}`, code);
console.log(really ? `published ${RELEASE_DEFAULTS.name}@${version}` : 'dry run ok — re-run with `--yes` to publish');
