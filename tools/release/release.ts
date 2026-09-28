/**
 * The single release entry point (ADR 0186), used from the laptop and by the
 * GitHub Actions workflow alike.
 *
 *   bun tools/release/release.ts [all|pack|verify|publish] --channel dev|latest [options]
 *
 *   all (default)  pack → verify → publish (publish is a dry run without --yes)
 *   pack           release:pack for the channel
 *   verify         release:verify (all platforms, or --platform <p> [--out <file>])
 *   publish        release:publish for the channel
 *
 * Options: --channel dev|latest (default dev) · --yes · --provenance (GitHub
 * Actions only) · --accept-unverified <platform[,…]> · --platform · --out ·
 * --working-tree (pack; never publishable).
 *
 * Examples:
 *   mise run release                                   # dev build: pack, verify, dry-run publish
 *   mise run release -- --channel dev --yes --accept-unverified linux/amd64
 *   mise run release -- --channel latest --yes         # needs tag v<version> + CHANGELOG date
 */
import { join } from 'node:path';
import { BUN_VERSION, CHANNELS, ROOT, die, type Channel } from './common';

const argv = process.argv.slice(2);
const steps = ['all', 'pack', 'verify', 'publish'] as const;
type Step = (typeof steps)[number];
const step: Step = steps.includes(argv[0] as Step) ? (argv.shift() as Step) : 'all';
const opt = (f: string) => {
	const i = argv.indexOf(f);
	return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (f: string) => argv.includes(f);
const channel = (opt('--channel') ?? 'dev') as Channel;
if (!CHANNELS.includes(channel)) die(`--channel must be one of ${CHANNELS.join(', ')}`);
if (Bun.version !== BUN_VERSION) console.warn(`release: running Bun ${Bun.version}, the project pins ${BUN_VERSION} (.bun-version)`);

const pass = (names: string[]) => names.flatMap((n) => (flag(n) ? [n] : opt(n) !== undefined && !opt(n)!.startsWith('--') ? [n, opt(n)!] : []));

async function run(script: string, args: string[]): Promise<void> {
	console.log(`\n$ bun tools/release/${script} ${args.join(' ')}`);
	const p = Bun.spawn(['bun', join(ROOT, 'tools/release', script), ...args], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', env: process.env });
	const code = await p.exited;
	if (code !== 0) die(`${script} failed (exit ${code})`, code);
}

if (step === 'all' || step === 'pack') await run('pack.ts', ['--channel', channel, ...pass(['--version', '--ref', '--working-tree'])]);
if (step === 'all' || step === 'verify') await run('verify.ts', pass(['--platform', '--out', '--timeout', '--emulated']));
if (step === 'all' || step === 'publish') await run('publish.ts', ['--channel', channel, ...pass(['--yes', '--provenance', '--accept-unverified'])]);
