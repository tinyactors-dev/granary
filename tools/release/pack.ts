/**
 * release:pack (ADR 0180): build granary from a clean export of a git ref and
 * assemble the publishable npm package.
 *
 *   bun tools/release/pack.ts [--ref <git-ref>] [--working-tree] [--allow-missing-cli]
 *
 * - Source: `git archive <ref>` (default HEAD) into release/work/src, so only
 *   committed code ships and the developer's own build/ is never touched.
 *   `--working-tree` copies tracked + untracked-not-ignored files instead
 *   (for trying uncommitted changes; the result is marked dirty and
 *   release:publish refuses it).
 * - Build: `bun install --frozen-lockfile`, `bun --bun vite build`, and the
 *   CLI via the `cli` mise task (E1) → dist/cli.js.
 * - Stage: release/package/ with a generated package.json (the repo's own
 *   package.json stays the private dev manifest), then `bun pm pack` →
 *   release/<name>-<version>.tgz, and release/meta.json.
 *
 * Missing dist/cli.js fails, unless --allow-missing-cli, which stages a
 * placeholder `granary` that exits 70 with a clear message (pipeline testing
 * before the CLI exists).
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
	META_FILE,
	RELEASE_DEFAULTS,
	RELEASE_DIR,
	ROOT,
	STAGE_DIR,
	WORK_DIR,
	die,
	mustSh,
	rootVersion,
	sh,
	sha256File,
	type PackMeta
} from './common';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
	const i = args.indexOf(f);
	return i >= 0 ? args[i + 1] : undefined;
};
const ref = opt('--ref') ?? 'HEAD';
const fromWorkingTree = flag('--working-tree');
const allowMissingCli = flag('--allow-missing-cli');

const version = await rootVersion();
const gitSha = (await mustSh(['git', 'rev-parse', `${ref}^{commit}`])).trim();
const dirty = fromWorkingTree && (await mustSh(['git', 'status', '--porcelain'])).trim() !== '';
const src = join(WORK_DIR, 'src');

console.log(`release:pack ${RELEASE_DEFAULTS.name}@${version} from ${fromWorkingTree ? 'working tree' : ref} (${gitSha.slice(0, 12)}${dirty ? ', dirty' : ''})`);

// 1. Clean export ------------------------------------------------------------
await rm(WORK_DIR, { recursive: true, force: true });
await rm(STAGE_DIR, { recursive: true, force: true });
await mkdir(src, { recursive: true });
if (fromWorkingTree) {
	const list = (await mustSh(['git', 'ls-files', '-z', '-co', '--exclude-standard'])).split('\0').filter(Boolean);
	for (const f of list) {
		const from = join(ROOT, f);
		const st = await stat(from).catch(() => null);
		if (!st?.isFile()) continue; // deleted in the working tree
		await mkdir(dirname(join(src, f)), { recursive: true });
		await cp(from, join(src, f));
	}
} else {
	const tar = join(WORK_DIR, 'src.tar');
	await mustSh(['git', 'archive', '--format=tar', '-o', tar, gitSha]);
	await mustSh(['tar', '-xf', tar, '-C', src]);
	await rm(tar);
}

// 2. Build ------------------------------------------------------------------
console.log('  install (frozen lockfile)…');
await mustSh(['bun', 'install', '--frozen-lockfile'], { cwd: src });
console.log('  build server (vite)…');
await mustSh(['bun', '--bun', 'vite', 'build'], { cwd: src, env: { NODE_ENV: 'production' } });
const miseToml = await Bun.file(join(src, 'mise.toml')).text();
if (/^\[tasks\.cli\]/m.test(miseToml)) {
	console.log('  build CLI (mise run cli)…');
	await mustSh(['mise', 'run', 'cli'], { cwd: src });
}
const cliBuilt = await Bun.file(join(src, 'dist/cli.js')).exists();
if (!cliBuilt && !allowMissingCli) {
	die('dist/cli.js is missing: the CLI build (mise task `cli`, ADR 0159/0166 fork E1) does not exist at this ref yet. Use --allow-missing-cli to stage a placeholder for pipeline testing.');
}

// 3. Runtime dependencies: everything the bundles import by bare specifier --
const external = new Set<string>(['@tinyactors/node', '@sinclair/typebox']);
const transpiler = new Bun.Transpiler({ loader: 'js' });
async function scan(dir: string): Promise<void> {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== 'client') await scan(p); // client assets are self-contained
			continue;
		}
		if (!/\.(m?js)$/.test(e.name)) continue;
		const code = await Bun.file(p).text();
		// Bun's own scanner: real import/require specifiers only (no comments/strings).
		for (const { path: spec } of transpiler.scanImports(code)) {
			if (spec.startsWith('.') || spec.startsWith('/') || /^(node|bun):/.test(spec)) continue;
			const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
			external.add(name);
		}
	}
}
await scan(join(src, 'build'));
if (cliBuilt) await scan(join(src, 'dist'));
const builtins = new Set(['bun', 'fs', 'path', 'os', 'crypto', 'url', 'util', 'events', 'stream', 'buffer', 'http', 'https', 'net', 'tls', 'zlib', 'child_process', 'worker_threads', 'module', 'assert', 'querystring', 'string_decoder', 'timers', 'readline', 'dns', 'perf_hooks', 'async_hooks', 'v8', 'vm', 'tty', 'process', 'constants', 'stream/web', 'fs/promises']);
const dependencies: Record<string, string> = {};
for (const name of [...external].sort()) {
	if (builtins.has(name)) continue;
	const pj = Bun.file(join(src, 'node_modules', name, 'package.json'));
	if (!(await pj.exists())) die(`bundle imports "${name}" but it is not installed in the export — add it to package.json dependencies`);
	dependencies[name] = ((await pj.json()) as { version: string }).version; // pinned to the lockfile's resolution
}

// 4. Stage ------------------------------------------------------------------
await mkdir(STAGE_DIR, { recursive: true });
await cp(join(src, 'build'), join(STAGE_DIR, 'build'), { recursive: true });
await mkdir(join(STAGE_DIR, 'dist'), { recursive: true });
if (cliBuilt) {
	await cp(join(src, 'dist/cli.js'), join(STAGE_DIR, 'dist/cli.js'));
} else {
	await Bun.write(
		join(STAGE_DIR, 'dist/cli.js'),
		`#!/usr/bin/env bun\nconsole.error('granary: this package was packed without the CLI (placeholder from release:pack --allow-missing-cli); it cannot run.');\nprocess.exit(70);\n`
	);
}
const cliHead = (await Bun.file(join(STAGE_DIR, 'dist/cli.js')).text()).slice(0, 40);
if (!cliHead.startsWith('#!')) die('dist/cli.js has no shebang (expected "#!/usr/bin/env bun")');
const manual = join(src, 'docs/manual');
const hasManual = await stat(manual).then((s) => s.isDirectory()).catch(() => false);
if (hasManual) await cp(manual, join(STAGE_DIR, 'docs/manual'), { recursive: true });
for (const f of ['LICENSE', 'CHANGELOG.md']) {
	if (!(await Bun.file(join(src, f)).exists())) die(`${f} is missing at this ref`);
	await cp(join(src, f), join(STAGE_DIR, f));
}
const readme = (await Bun.file(join(src, 'tools/release/README.package.md')).exists())
	? join(src, 'tools/release/README.package.md')
	: join(src, 'README.md');
await cp(readme, join(STAGE_DIR, 'README.md'));

const manifest = {
	name: RELEASE_DEFAULTS.name,
	version,
	description: 'Auto-closes GitHub issues from people who are not on your allowlist — durable, observable, runs on Bun.',
	license: RELEASE_DEFAULTS.license,
	author: RELEASE_DEFAULTS.author,
	homepage: RELEASE_DEFAULTS.homepage,
	repository: { type: 'git', url: `git+${RELEASE_DEFAULTS.repository}.git` },
	bugs: { url: `${RELEASE_DEFAULTS.repository}/issues` },
	keywords: ['github', 'issues', 'moderation', 'bun', 'tinyactors', 'statecharts'],
	type: 'module',
	bin: { granary: 'dist/cli.js' },
	files: ['build/', 'dist/', ...(hasManual ? ['docs/manual/'] : []), 'README.md', 'LICENSE', 'CHANGELOG.md'],
	engines: { bun: RELEASE_DEFAULTS.bunEngine },
	os: ['linux', 'darwin'],
	dependencies,
	publishConfig: { access: RELEASE_DEFAULTS.access, registry: RELEASE_DEFAULTS.registry },
	granary: { gitSha, source: fromWorkingTree ? 'working-tree' : 'git', dirty }
};
await Bun.write(join(STAGE_DIR, 'package.json'), JSON.stringify(manifest, null, '\t') + '\n');

// 5. Pack -------------------------------------------------------------------
for (const e of await readdir(RELEASE_DIR)) if (e.endsWith('.tgz')) await rm(join(RELEASE_DIR, e));
const packed = await sh(['bun', 'pm', 'pack', '--destination', RELEASE_DIR, '--quiet', '--ignore-scripts'], { cwd: STAGE_DIR });
if (packed.code !== 0) die(`bun pm pack failed:\n${packed.out}`);
const tgzName = (await readdir(RELEASE_DIR)).find((e) => e.endsWith('.tgz'));
if (!tgzName) die('bun pm pack produced no tarball');
const tarball = join(RELEASE_DIR, tgzName);
const meta: PackMeta = {
	name: RELEASE_DEFAULTS.name,
	version,
	gitSha,
	source: fromWorkingTree ? 'working-tree' : 'git',
	dirty,
	builtAt: new Date().toISOString(),
	tarball: relative(ROOT, tarball),
	sha256: await sha256File(tarball),
	cliPlaceholder: !cliBuilt,
	dependencies
};
await Bun.write(META_FILE, JSON.stringify(meta, null, '\t') + '\n');
const size = (await stat(tarball)).size;
console.log(`  packed ${meta.tarball} (${(size / 1024).toFixed(0)} KiB, sha256 ${meta.sha256.slice(0, 16)}…)`);
console.log(`  dependencies: ${Object.entries(dependencies).map(([k, v]) => `${k}@${v}`).join(', ')}`);
if (!cliBuilt) console.warn('  WARNING: dist/cli.js is a placeholder (--allow-missing-cli); this tarball must not be published.');
