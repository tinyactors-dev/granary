/**
 * `granary update` (ADR 0301): bring this host to the newest version of an
 * npm channel, the way `mise run deploy` does from a laptop (ADR 0233), but
 * pulled by the host itself. A systemd timer runs it as root every few
 * minutes (`granary systemd-unit --unit update-timer`).
 *
 * 1. the channel's version is the dist-tag on the npm registry (a version
 *    still in npm's review is not tagged yet, so it waits for a later run);
 * 2. the running version is what `/healthz` reports (HOST/PORT from the data
 *    dir's granary.env); equal → nothing to do;
 * 3. `bun add -g --force @tinyactors/granary@<version>` under BUN_INSTALL,
 *    `systemctl restart <service>`, then wait until `/healthz` reports it;
 * 4. if it does not within the timeout, reinstall the version that ran
 *    before, restart, and fail (the journal says why).
 */
import type { Parsed } from './args';
import { CliError, print, type Context } from './context';
import { EXIT } from '../lib/schemas/cli';
import { VERSION } from '../lib/version';

const PACKAGE = '@tinyactors/granary';
const REGISTRY = 'https://registry.npmjs.org';

export interface UpdateResult {
	channel: string;
	running: string | null;
	target: string;
	action: 'up-to-date' | 'updated' | 'not-yet-available' | 'planned';
}

/** The version the channel's dist-tag points at. */
async function channelVersion(channel: string): Promise<string> {
	const res = await fetch(`${REGISTRY}/${PACKAGE.replace('/', '%2f')}`, {
		headers: { accept: 'application/vnd.npm.install-v1+json', 'cache-control': 'no-cache' },
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new CliError(`npm registry: HTTP ${res.status} for ${PACKAGE}`, EXIT.error);
	const tags = ((await res.json()) as { 'dist-tags'?: Record<string, string> })['dist-tags'] ?? {};
	const v = tags[channel];
	if (!v) throw new CliError(`npm has no "${channel}" dist-tag for ${PACKAGE}`, EXIT.error);
	return v;
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
	const channel = String(p.options.channel ?? 'dev');
	if (channel !== 'dev' && channel !== 'latest') throw new CliError('--channel must be dev or latest', EXIT.usage);
	const bunInstall = String(p.options['bun-install'] ?? '/opt/bun');
	const service = String(p.options.service ?? 'granary');
	const timeoutMs = Number(p.options.timeout ?? 60) * 1000;
	const dryRun = p.options['dry-run'] === true;
	const health = healthURL(ctx.envFileVars);

	const target = await channelVersion(channel);
	const running = (await runningVersion(health)) ?? null;
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
	const install = (version: string) => run([bun, 'add', '-g', '--force', `${PACKAGE}@${version}`], { BUN_INSTALL: bunInstall });
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
	const installed = await install(target);
	if (installed.code !== 0) {
		// The dist-tag can lead the tarball by a moment while npm processes a publish: try again next run.
		if (/No version matching|failed to resolve|404/i.test(installed.out)) {
			say(result('not-yet-available'), `granary ${target} is not installable yet; will retry\n${installed.out}`);
			return EXIT.ok;
		}
		throw new CliError(`bun add -g ${PACKAGE}@${target} failed:\n${installed.out}`, EXIT.error);
	}
	if (await restartAndWait(target)) {
		say(result('updated'), `granary updated to ${target}; ${health} reports it`);
		return EXIT.ok;
	}

	// Roll back to what ran before (or, if nothing answered, to this CLI's own version).
	const previous = running ?? VERSION;
	console.error(`granary update: ${target} did not come up within ${timeoutMs / 1000}s; rolling back to ${previous}`);
	const back = await install(previous);
	if (back.code !== 0) throw new CliError(`rollback: bun add -g ${PACKAGE}@${previous} failed:\n${back.out}`, EXIT.error);
	const ok = await restartAndWait(previous);
	throw new CliError(`granary ${target} did not start; ${ok ? `rolled back to ${previous}` : `rollback to ${previous} did not come up either`}`, EXIT.error);
}
