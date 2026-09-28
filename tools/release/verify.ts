/**
 * release:verify (ADR 0181): install the packed tarball on clean Linux hosts
 * (the `oven/bun:<min version>` image, per platform) and exercise it:
 * global install, native addon, `granary version|init|doctor|serve`,
 * `/healthz`, `/readyz`, graceful stop.
 *
 *   bun tools/release/verify.ts [--platform linux/arm64] [--out release/verify-arm64.json] [--allow-missing] [--timeout 600]
 *
 * Each container runs as a pitchfork daemon (PROCESS RULES) through
 * tools/dev/container.sh with an exact container name, and is removed after.
 * In CI (`CI=true`, no developer daemons to protect) the container runs as a
 * child process of this script instead, reaped by it (ADR 0186).
 * Results: release/verify.json (or --out), read by release:publish. With
 * --platform, results for other platforms already recorded for the same
 * tarball are kept.
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
const tryEmulated = args.includes('--emulated');
const timeoutS = Number(opt('--timeout') ?? 600);
const platforms = opt('--platform') ? [opt('--platform')!] : [...RELEASE_DEFAULTS.platforms];
const outFile = opt('--out') ? join(ROOT, opt('--out')!) : VERIFY_FILE;
const inCi = process.env.CI === 'true';
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
	if (emulatedX64 && !tryEmulated) {
		const why = 'emulated x86-64 (qemu) on an arm64 docker host: Bun 1.4.1 crashes here (`bun add` exits 139, even with the baseline build). Verify natively (x86-64 host or the CI workflow, ADR 0186), use colima with --vz-rosetta, or pass --emulated to try anyway.';
		console.log(`\n== ${platform} — SKIPPED\n  ${why}`);
		results.push({ platform, ok: false, skipped: why, steps: [] });
		continue;
	}
	const bunMount = emulatedX64 ? ['-v', `${await baselineBun()}:/usr/local/bin/bun:ro`] : [];
	console.log(`\n== ${platform} (${image}${emulatedX64 ? ', emulated: baseline Bun' : ''}) — daemon ${id}`);
	await sh(['docker', 'pull', '-q', '--platform', platform, image], { quiet: true });
	const containerArgs = [
		join(ROOT, 'tools/dev/container.sh'), id,
		'--platform', platform,
		'-v', `${join(dir, 'granary.tgz')}:/pkg/granary.tgz:ro`,
		'-v', `${dir}:/verify`,
		'-w', '/verify',
		...bunMount,
		image, 'bun', '/verify/inside.ts'
	];
	const resultFile = join(dir, 'out', 'result.json');
	let logs = '';
	if (inCi) {
		// CI: a child process owned and reaped by this script.
		const child = Bun.spawn(containerArgs, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
		const timer = setTimeout(() => void sh(['docker', 'stop', '-t', '5', id], { quiet: true }), timeoutS * 1000);
		const [o, e] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		await child.exited;
		clearTimeout(timer);
		logs = (o + e).slice(-4000);
		await sh(['docker', 'rm', '-f', id], { quiet: true });
	} else {
		const started = await pitchfork('run', id, '--force', '--delay', '1', '--', ...containerArgs);
		if (started.code !== 0 && !/started|exited|stopped/i.test(started.out)) console.warn(`  pitchfork run: ${started.out.trim().slice(-300)}`);

		// Wait for result.json (the container exits right after writing it).
		const until = Date.now() + timeoutS * 1000;
		const containerUp = async () => (await sh(['docker', 'ps', '-q', '--filter', `name=^${id}$`], { quiet: true })).out.trim() !== '';
		let sawContainer = false;
		while (Date.now() < until && !(await Bun.file(resultFile).exists())) {
			await Bun.sleep(2000);
			const up = await containerUp();
			if (up) sawContainer = true;
			else if (sawContainer || Date.now() > until - timeoutS * 1000 + 60_000) break; // died (or never came up) without a result
		}
		await pitchfork('stop', id); // no-op when it already exited; stops the container otherwise
		// Belt and braces: remove this run's container by its exact name.
		await sh(['docker', 'rm', '-f', id], { quiet: true });
		logs = (await pitchfork('logs', id, '-n', '60')).out;
	}

	const r = await readJson<{ ok: boolean; steps: VerifyResult['steps'] }>(resultFile);
	if (!r) {
		const crashed = /panic|Segmentation fault|has crashed/.test(logs);
		const detail = `${crashed ? 'the verifier crashed' : 'no result'} (container ended or ${timeoutS} s passed)\n${logs.slice(-1500)}`;
		results.push({ platform, ok: false, steps: [{ name: 'container run', ok: false, detail }] });
		console.log(`  FAIL: ${detail.split('\n')[0]} — see \`pitchfork logs ${id}\``);
		continue;
	}
	for (const s of r.steps) console.log(`  ${s.ok ? 'ok     ' : s.missing ? 'MISSING' : 'FAIL   '} ${s.name} — ${s.detail.split('\n')[0]}`);
	results.push({ platform, ok: r.ok, steps: r.steps });
}

// Keep results for platforms not run now, if they are for this same tarball.
const previous = await readJson<VerifyReport>(outFile);
const kept = previous && previous.sha256 === meta.sha256 ? previous.results.filter((r) => !platforms.includes(r.platform)) : [];
const all = [...kept, ...results];
const report: VerifyReport = {
	tarball: meta.tarball,
	sha256: meta.sha256,
	gitSha: meta.gitSha,
	at: new Date().toISOString(),
	ok: all.every((r) => r.ok || r.skipped) && all.some((r) => r.ok) && !meta.cliPlaceholder,
	results: all
};
await Bun.write(outFile, JSON.stringify(report, null, '\t') + '\n');

const failed = results.flatMap((r) => r.steps.filter((s) => !s.ok && !s.missing).map((s) => `${r.platform}: ${s.name}`));
const skipped = results.filter((r) => r.skipped).map((r) => r.platform);
const missing = results.flatMap((r) => r.steps.filter((s) => s.missing).map((s) => `${r.platform}: ${s.name}`));
console.log(`\nrelease:verify ${report.ok ? 'PASSED' : 'NOT PASSED'} for ${meta.name}@${meta.version} (${meta.gitSha.slice(0, 12)})`);
if (missing.length) console.log(`  missing in this build (not failures): \n    ${missing.join('\n    ')}`);
if (skipped.length) console.log(`  skipped (unverified — release:publish needs --accept-unverified ${skipped.join(',')}): ${skipped.join(', ')}`);
if (failed.length) console.log(`  failed:\n    ${failed.join('\n    ')}`);
process.exit(report.ok ? 0 : failed.length === 0 && allowMissing ? 2 : 1);
