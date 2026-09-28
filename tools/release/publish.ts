/**
 * release:publish (ADR 0182, 0185, 0186, 0188): publish the verified tarball
 * to npm under the channel's dist-tag.
 *
 *   bun tools/release/publish.ts [--channel latest|dev] [--yes] [--provenance] [--accept-unverified linux/amd64]
 *
 * Dry run unless --yes. Refuses unless ALL hold:
 *   both channels
 *   - clean git tree; release/meta.json packed from git (not --working-tree)
 *     at HEAD, tarball present with matching sha256
 *   - the packed channel matches --channel
 *   - a passing verify for that exact tarball (release/verify*.json merged);
 *     platforms not verified need --accept-unverified <platform>
 *   - the version is not already on the registry
 *   latest
 *   - version is not a prerelease; HEAD tagged `v<version>`; CHANGELOG.md has
 *     a dated `## [<version>] - <date>` entry
 *   dev
 *   - version is `<x.y.z>-dev.…`; the package already has a stable `latest`
 *     (npm points `latest` at a brand-new package's first version whatever
 *     the tag, so the first-ever publish must be stable — ADR 0188)
 *
 * Upload: the npm CLI (`bun publish` cannot attest provenance), with
 * `--tag <channel>`. Credentials: NPM_TOKEN via a throwaway userconfig that
 * references ${NPM_TOKEN} (the token never touches disk); locally the token is
 * injected by `fnox exec -P release` around the npm process only. In GitHub
 * Actions with --provenance and no NPM_TOKEN, npm's trusted publishing (OIDC)
 * is used. --provenance is refused outside GitHub Actions.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CHANNELS,
	META_FILE,
	RELEASE_DEFAULTS,
	ROOT,
	die,
	hasOidc,
	isGitHubActions,
	isPrerelease,
	loadVerify,
	npmCmd,
	npmView,
	readJson,
	sh,
	sha256File,
	type Channel,
	type PackMeta
} from './common';

const args = process.argv.slice(2);
const opt = (f: string) => {
	const i = args.indexOf(f);
	return i >= 0 ? args[i + 1] : undefined;
};
const really = args.includes('--yes');
const provenance = args.includes('--provenance');
const channel = (opt('--channel') ?? 'latest') as Channel;
if (!CHANNELS.includes(channel)) die(`--channel must be one of ${CHANNELS.join(', ')}`);
const acceptUnverified = new Set((opt('--accept-unverified') ?? '').split(',').filter(Boolean));
const problems: string[] = [];
const check = (cond: unknown, msg: string) => {
	if (!cond) problems.push(msg);
};

// Git state ------------------------------------------------------------------
const head = (await sh(['git', 'rev-parse', 'HEAD'])).out.trim();
const status = (await sh(['git', 'status', '--porcelain'])).out.trim();
check(status === '', 'git tree is not clean (commit or stash first)');

// The packed tarball ----------------------------------------------------------
const meta = await readJson<PackMeta>(META_FILE);
if (!meta) die('no release/meta.json — run `mise run release:pack` (or `mise run release`)');
const version = meta.version;
check((meta.channel ?? 'latest') === channel, `the tarball was packed for channel ${meta.channel ?? 'latest'}, not ${channel} — re-pack with --channel ${channel}`);
check(meta.source === 'git' && !meta.dirty, 'tarball was packed from the working tree — re-pack from git');
check(meta.gitSha === head, `tarball was packed at ${meta.gitSha.slice(0, 12)}, HEAD is ${head.slice(0, 12)} — re-pack`);
const tgz = join(ROOT, meta.tarball);
const present = await Bun.file(tgz).exists();
check(present, `${meta.tarball} is missing`);
if (present) check((await sha256File(tgz)) === meta.sha256, `${meta.tarball} changed since packing`);

// Channel rules ----------------------------------------------------------------
if (channel === 'latest') {
	check(!isPrerelease(version), `${version} is a prerelease — it can never be published as latest (ADR 0188)`);
	const tags = (await sh(['git', 'tag', '--points-at', 'HEAD'])).out.split('\n').map((t) => t.trim());
	check(tags.includes(`v${version}`), `HEAD is not tagged v${version} (git tag -a v${version} -m "granary ${version}")`);
	const changelog = await Bun.file(join(ROOT, 'CHANGELOG.md')).text();
	const entry = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]\\s*-\\s*(.+)$`, 'm').exec(changelog);
	check(entry, `CHANGELOG.md has no "## [${version}] - <date>" entry`);
	check(!entry || !/unreleased/i.test(entry[1]!), `CHANGELOG.md entry for ${version} is still marked unreleased — set the release date`);
} else {
	check(/^\d+\.\d+\.\d+-dev\./.test(version), `dev channel versions look like <x.y.z>-dev.<epoch>.g<sha>, got ${version}`);
}

// Verification -----------------------------------------------------------------
const verify = await loadVerify(meta.sha256);
check(verify, 'no verify results for this tarball — run `mise run release:verify`');
if (verify) {
	for (const p of RELEASE_DEFAULTS.platforms) {
		const r = verify.results.find((x) => x.platform === p);
		if (r?.ok) continue;
		if (acceptUnverified.has(p)) {
			console.warn(`WARNING: publishing without verification on ${p} (--accept-unverified)${r?.skipped ? `: ${r.skipped}` : ''}`);
			continue;
		}
		check(false, r?.skipped ? `${p} was not verified (${r.skipped.split(':')[0]}) — verify it natively (CI does), or pass --accept-unverified ${p}` : `no passing verify for ${p}`);
	}
	const failed = verify.results.filter((r) => !r.ok && !r.skipped).map((r) => r.platform);
	check(failed.length === 0, `release:verify failed on ${failed.join(', ')}`);
}

// Registry -----------------------------------------------------------------------
const distTags = await npmView<Record<string, string>>(RELEASE_DEFAULTS.name, 'dist-tags');
const already = await npmView<string>(`${RELEASE_DEFAULTS.name}@${version}`, 'version');
check(already !== version, `${RELEASE_DEFAULTS.name}@${version} is already published`);
if (channel === 'dev') {
	check(distTags?.latest && !isPrerelease(distTags.latest), `${RELEASE_DEFAULTS.name} has no stable "latest" yet — npm would make this dev build "latest"; publish a stable release first (ADR 0188)`);
}

// Credentials & provenance -------------------------------------------------------------
if (provenance) check(isGitHubActions() && hasOidc(), '--provenance needs GitHub Actions with `permissions: id-token: write` (ADR 0186)');
const token = process.env.NPM_TOKEN;
const trusted = provenance && !token && hasOidc(); // npm trusted publishing (OIDC), no long-lived token
const viaFnox = !token && !isGitHubActions(); // laptop: fnox injects NPM_TOKEN into the npm process only
if (really && !token && !trusted && !viaFnox) check(false, 'no credentials: set NPM_TOKEN or use trusted publishing (--provenance in GitHub Actions)');

if (problems.length) {
	console.error(`release:publish refused (${problems.length} problem${problems.length > 1 ? 's' : ''}):\n  - ${problems.join('\n  - ')}`);
	process.exit(1);
}

// Upload ----------------------------------------------------------------------------
const npm = await npmCmd();
const userconfig = await mkdtemp(join(tmpdir(), 'granary-npmrc-'));
const npmrc = join(userconfig, 'npmrc');
const registryHost = RELEASE_DEFAULTS.registry.replace(/^https?:/, '').replace(/\/?$/, '/');
// `${NPM_TOKEN}` is expanded by npm from its own environment; the file never holds the token.
await Bun.write(npmrc, trusted ? '' : `${registryHost}:_authToken=\${NPM_TOKEN}\n`);
const publishArgs = [
	...npm, 'publish', tgz,
	'--tag', channel,
	'--access', RELEASE_DEFAULTS.access,
	'--registry', RELEASE_DEFAULTS.registry,
	'--userconfig', npmrc,
	...(provenance ? ['--provenance'] : []),
	...(really ? [] : ['--dry-run'])
];
const cmd = viaFnox && really ? ['fnox', 'exec', '-P', 'release', '--', ...publishArgs] : publishArgs;
console.log(
	`${really ? 'PUBLISHING' : 'dry run:'} ${RELEASE_DEFAULTS.name}@${version} → dist-tag "${channel}" (${meta.gitSha.slice(0, 12)}, sha256 ${meta.sha256.slice(0, 16)}…) ` +
		`${provenance ? 'with provenance' : 'without provenance'}${trusted ? ', trusted publishing (OIDC)' : ''}`
);
const r = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, NPM_TOKEN: token ?? process.env.NPM_TOKEN ?? '' }, stdout: 'inherit', stderr: 'inherit' });
const code = await r.exited;
await rm(userconfig, { recursive: true, force: true });
if (code !== 0) die(`npm publish exited ${code}`, code);

if (really) {
	// Belt and braces (ADR 0188): a prerelease must never be "latest".
	const after = await npmView<Record<string, string>>(RELEASE_DEFAULTS.name, 'dist-tags');
	if (after?.latest && isPrerelease(after.latest)) {
		console.error(`WARNING: "latest" points at prerelease ${after.latest} — move it back: mise run release:promote -- <stable version>`);
		process.exit(1);
	}
	console.log(`published ${RELEASE_DEFAULTS.name}@${version} (dist-tag ${channel}); dist-tags now: ${JSON.stringify(after ?? {})}`);
} else {
	console.log(`dry run ok — re-run with --yes to publish`);
}
