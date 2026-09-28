/**
 * release:verify (ADR 0181): install the packed tarball on clean Linux hosts
 * (the `oven/bun:<min version>` image, per platform) and exercise it:
 * global install, native addon, `granary version|init|doctor|serve`,
 * `/healthz`, `/readyz`, graceful stop.
 *
 *   bun tools/release/verify.ts [--platform linux/arm64] [--allow-missing] [--timeout 600]
 *
 * Each container runs as a pitchfork daemon (PROCESS RULES) through
 * tools/dev/container.sh with an exact container name, and is removed after.
 * Results: release/verify.json (read by release:publish).
 * Exit: 0 all ok · 2 only `missing` steps and --allow-missing · 1 otherwise.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	META_FILE,
	RELEASE_DEFAULTS,
	RELEASE_DIR,
	ROOT,
	VERIFY_FILE,
	die,
	readJson,
	sh,
	sha256File,
	type PackMeta,
	type VerifyReport,
	type VerifyResult
} from './common';

const args = process.argv.slice(2);
const opt = (f: string) => {
	const i = args.indexOf(f);
	return i >= 0 ? args[i + 1] : undefined;
};
const allowMissing = args.includes('--allow-missing');
const timeoutS = Number(opt('--timeout') ?? 600);
const platforms = opt('--platform') ? [opt('--platform')!] : [...RELEASE_DEFAULTS.platforms];
const image = `oven/bun:${RELEASE_DEFAULTS.bunEngine.replace(/^>=\s*/, '')}`;

const meta = await readJson<PackMeta>(META_FILE);
if (!meta) die('no release/meta.json — run `mise run release:pack` first');
const tarball = join(ROOT, meta.tarball);
if (!(await Bun.file(tarball).exists())) die(`${meta.tarball} is missing — run release:pack again`);
if ((await sha256File(tarball)) !== meta.sha256) die(`${meta.tarball} does not match release/meta.json — run release:pack again`);

const pitchfork = async (...a: string[]) => sh(['mise', 'x', 'pitchfork', '--', 'pitchfork', ...a], { quiet: true });

// Emulated amd64 (e.g. colima on Apple silicon) has no AVX, which the default
// Bun build needs ("CPU lacks AVX support" → crash). Real x86 hosts have AVX, so
// for emulated runs we mount Bun's official *baseline* build over the image's
// bun — same version, no AVX requirement (ADR 0181).
const hostArch = ((await sh(['docker', 'info', '--format', '{{.Architecture}}'], { quiet: true })).out.trim() === 'x86_64' ? 'amd64' : 'arm64');
const bunVersion = RELEASE_DEFAULTS.bunEngine.replace(/^>=\s*/, '');
async function baselineBun(): Promise<string> {
	const dir = join(RELEASE_DIR, 'cache', `bun-${bunVersion}-linux-x64-baseline`);
	const bin = join(dir, 'bun');
	if (await Bun.file(bin).exists()) return bin;
	await mkdir(dir, { recursive: true });
	const url = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-x64-baseline.zip`;
	console.log(`  downloading ${url}`);
	const res = await fetch(url);
	if (!res.ok) die(`download failed: ${res.status} ${url}`);
	const zip = join(dir, 'bun.zip');
	await Bun.write(zip, res);
	const u = await sh(['unzip', '-o', '-j', zip, '*/bun', '-d', dir]);
	if (u.code !== 0) die(`unzip failed: ${u.out}`);
	await sh(['chmod', '+x', bin]);
	return bin;
}

const results: VerifyResult[] = [];
for (const platform of platforms) {
	const arch = platform.split('/')[1]!;
	const id = `granary-verify-${arch}`; // pitchfork daemon id == docker container name
	const dir = join(RELEASE_DIR, 'verify', arch);
	await rm(dir, { recursive: true, force: true });
	await mkdir(join(dir, 'out'), { recursive: true });
	await cp(join(import.meta.dir, 'verify-inside.ts'), join(dir, 'inside.ts'));
	await cp(tarball, join(dir, 'granary.tgz'));

	const emulatedX64 = arch === 'amd64' && hostArch !== 'amd64';
	const bunMount = emulatedX64 ? ['-v', `${await baselineBun()}:/usr/local/bin/bun:ro`] : [];
	console.log(`\n== ${platform} (${image}${emulatedX64 ? ', emulated: baseline Bun' : ''}) — daemon ${id}`);
	await sh(['docker', 'pull', '-q', '--platform', platform, image], { quiet: true });
	const started = await pitchfork(
		'run', id, '--force', '--delay', '1', '--',
		join(ROOT, 'tools/dev/container.sh'), id,
		'--platform', platform,
		'-v', `${join(dir, 'granary.tgz')}:/pkg/granary.tgz:ro`,
		'-v', `${dir}:/verify`,
		'-w', '/verify',
		...bunMount,
		image, 'bun', '/verify/inside.ts'
	);
	if (started.code !== 0 && !/started|exited|stopped/i.test(started.out)) console.warn(`  pitchfork run: ${started.out.trim().slice(-300)}`);

	// Wait for result.json (the container exits right after writing it).
	const resultFile = join(dir, 'out', 'result.json');
	const until = Date.now() + timeoutS * 1000;
	while (Date.now() < until && !(await Bun.file(resultFile).exists())) await Bun.sleep(2000);
	await pitchfork('stop', id); // no-op when it already exited; stops the container otherwise
	// Belt and braces: remove this run's container by its exact name.
	await sh(['docker', 'rm', '-f', id], { quiet: true });
	const logs = (await pitchfork('logs', id, '-n', '60')).out;

	const r = await readJson<{ ok: boolean; steps: VerifyResult['steps'] }>(resultFile);
	if (!r) {
		results.push({ platform, ok: false, steps: [{ name: 'container run', ok: false, detail: `no result within ${timeoutS} s\n${logs.slice(-1500)}` }] });
		console.log(`  FAIL: no result within ${timeoutS} s`);
		continue;
	}
	for (const s of r.steps) console.log(`  ${s.ok ? 'ok     ' : s.missing ? 'MISSING' : 'FAIL   '} ${s.name} — ${s.detail.split('\n')[0]}`);
	results.push({ platform, ok: r.ok, steps: r.steps });
}

const report: VerifyReport = {
	tarball: meta.tarball,
	sha256: meta.sha256,
	gitSha: meta.gitSha,
	at: new Date().toISOString(),
	ok: results.every((r) => r.ok) && !meta.cliPlaceholder,
	results
};
await Bun.write(VERIFY_FILE, JSON.stringify(report, null, '\t') + '\n');

const failed = results.flatMap((r) => r.steps.filter((s) => !s.ok && !s.missing).map((s) => `${r.platform}: ${s.name}`));
const missing = results.flatMap((r) => r.steps.filter((s) => s.missing).map((s) => `${r.platform}: ${s.name}`));
console.log(`\nrelease:verify ${report.ok ? 'PASSED' : 'NOT PASSED'} for ${meta.name}@${meta.version} (${meta.gitSha.slice(0, 12)})`);
if (missing.length) console.log(`  missing in this build (not failures): \n    ${missing.join('\n    ')}`);
if (failed.length) console.log(`  failed:\n    ${failed.join('\n    ')}`);
process.exit(report.ok ? 0 : failed.length === 0 && allowMissing ? 2 : 1);
