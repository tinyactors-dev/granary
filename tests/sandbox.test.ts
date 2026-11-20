/**
 * The sandbox (ADR 0312): `granary sandbox init` / `granary sandbox serve`
 * run a second granary whose GitHub is the fake GitHub on this machine. The
 * data dirs are never mixed up, a sandbox refuses a GitHub that is not on
 * this machine, both processes listen on 127.0.0.1 only, the sandbox
 * connects to its fake and says "Sandbox" on every page.
 *
 * Runs the built app and CLI as child processes it owns (no harness app).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { ROOT, cliEntry, freePort } from './harness';
import { EXIT } from '../src/lib/schemas/cli';

const T = 90_000;
const tmp = mkdtempSync(join(tmpdir(), 'granary-sandbox-'));
const dataDir = join(tmp, 'sandbox');
const children: Subprocess[] = [];

/** The CLI with a clean env: nothing of a developer's (or the harness') GitHub settings. */
const cleanEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: tmp, NODE_ENV: 'production' });

async function cli(args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(['bun', cliEntry(), ...args], { cwd: tmp, env: { ...cleanEnv(), ...env }, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

async function until<T>(fn: () => Promise<T | null>, what: string, timeout = 30_000): Promise<T> {
	const deadline = Date.now() + timeout;
	let last: unknown = null;
	while (Date.now() < deadline) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (e) {
			last = e;
		}
		await Bun.sleep(200);
	}
	throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ''}`);
}

afterAll(async () => {
	for (const c of children) c.kill('SIGTERM');
	await Promise.all(children.map((c) => c.exited));
	rmSync(tmp, { recursive: true, force: true });
});

describe('sandbox', () => {
	const appPort = freePort();
	const githubPort = freePort();

	test('init writes a marked data dir whose GitHub is the local fake; the two kinds of data dir are never mixed up', async () => {
		const r = await cli(['sandbox', 'init', '--data', dataDir, '--port', String(appPort), '--github-port', String(githubPort), '--json']);
		expect(r.code).toBe(EXIT.ok);
		const env = await Bun.file(join(dataDir, 'granary.env')).text();
		expect(env).toContain('GRANARY_SANDBOX=1');
		expect(env).toContain(`GRANARY_GITHUB_API_URL=http://localhost:${githubPort}`);
		expect(env).toContain('HOST=127.0.0.1');

		const serve = await cli(['serve', '--data', dataDir]);
		expect(serve.code).toBe(EXIT.dataDir);
		expect(serve.stderr).toContain('sandbox serve');
		const notSandbox = await cli(['sandbox', 'serve', '--data', tmp]);
		expect(notSandbox.code).toBe(EXIT.dataDir);
		expect((await cli(['sandbox', 'init'])).code).toBe(EXIT.usage);
	});

	test('the app refuses to start as a sandbox with a GitHub that is not on this machine', async () => {
		const proc = Bun.spawn(['bun', join(ROOT, 'build/index.js')], {
			cwd: tmp,
			env: { ...cleanEnv(), GRANARY_SANDBOX: '1', GRANARY_DATA_DIR: join(tmp, 'other'), GRANARY_MASTER_KEY: 'a0'.repeat(32), PORT: String(freePort()), GRANARY_GITHUB_API_URL: 'https://api.github.com', GRANARY_GITHUB_WEB_URL: 'https://github.com' },
			stdout: 'pipe',
			stderr: 'pipe'
		});
		children.push(proc);
		const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		clearTimeout(timer);
		expect(code).not.toBe(0);
		expect(out + err).toContain('a sandbox (GRANARY_SANDBOX=1) needs the fake GitHub on this machine');
	}, T);

	test(
		'serve runs the fake GitHub and the app on 127.0.0.1; the app connects to the fake and says Sandbox on every page',
		async () => {
			const proc = Bun.spawn(['bun', cliEntry(), 'sandbox', 'serve', '--data', dataDir], { cwd: tmp, env: cleanEnv(), stdout: 'pipe', stderr: 'pipe' });
			children.push(proc);
			const app = `http://127.0.0.1:${appPort}`;
			const github = `http://127.0.0.1:${githubPort}`;
			await until(async () => ((await fetch(`${app}/readyz`)).ok ? true : null), 'the sandbox app to be ready', 60_000);
			// GitHub here is the fake: granary created its app there by itself.
			const apps = await until(async () => {
				const s = (await (await fetch(`${github}/__control/state`)).json()) as { apps?: unknown[] };
				return s.apps?.length ? s.apps : null;
			}, 'the sandbox to connect to its fake GitHub');
			expect(apps).toHaveLength(1);
			const html = await (await fetch(`${app}/admin/sessions`)).text();
			expect(html).toContain('data-testid="sandbox-strip"');
			// Neither listens beyond this machine.
			const lan = (await import('node:os')).networkInterfaces();
			const external = Object.values(lan)
				.flat()
				.find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
			if (external) {
				await expect(fetch(`http://${external}:${appPort}/healthz`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
				await expect(fetch(`http://${external}:${githubPort}/healthz`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
			}
		},
		T
	);
});
