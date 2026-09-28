/**
 * The `granary` CLI against a running server and offline (ADR 0159, 0161,
 * 0203): init, admins, login links, config, doctor, exit codes.
 */
import { describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, cliEntry, runCli, useHarness, type Harness } from './harness';
import { consumeLoginLink } from './github-app';
import { EXIT, DATA_DIR_LAYOUT } from '../src/lib/schemas/cli';

const T = 60_000;

let initOutput: { code: number; stdout: string; stderr: string } | null = null;

const h: () => Harness = useHarness({
			/** Offline commands run before the server starts. */
			prepare: async (harness) => {
				// Blank the harness's GRANARY_MASTER_KEY so init generates (and prints) a new key instead of using the env one (ADR 0157).
				initOutput = await runCli(harness, ['init', '--origin', harness.appUrl, '--yes-i-stored-the-key', '--json'], { env: { GRANARY_MASTER_KEY: '' } });
				const key = /[0-9a-f]{64}/i.exec(initOutput.stdout)?.[0];
				if (key) harness.extraAppEnv.GRANARY_MASTER_KEY = key;
				await runCli(harness, ['admin', 'add', 'offline-admin']);
				await runCli(harness, ['config', 'set', 'ui.greeting', 'hello']);
			}
		});

describe('granary CLI', () => {
	test('init (offline) creates a private data dir, prints the key once and writes granary.env', () => {
		expect(initOutput?.code).toBe(EXIT.ok);
		expect(initOutput!.stdout).toMatch(/[0-9a-f]{64}/i);
		const mode = statSync(h().tmpDir).mode & 0o777;
		expect(mode).toBe(0o700);
		expect(existsSync(join(h().tmpDir, DATA_DIR_LAYOUT.envFile))).toBe(true);
	});

	test('init refuses while the server runs', async () => {
		const r = await runCli(h(), ['init', '--yes-i-stored-the-key']);
		expect(r.code).not.toBe(EXIT.ok);
	});

	test('admin list (socket) shows seeded and offline-added admins', async () => {
		expect(existsSync(join(h().tmpDir, DATA_DIR_LAYOUT.adminSocket))).toBe(true);
		const r = await runCli(h(), ['admin', 'list', '--json']);
		expect(r.code).toBe(EXIT.ok);
		const logins = (JSON.parse(r.stdout) as { login: string }[]).map((a) => a.login.toLowerCase());
		expect(logins).toEqual(expect.arrayContaining(['admin', 'offline-admin']));
	});

	test(
		'admin add + login-link: the new admin signs in with the one-time link',
		async () => {
			expect((await runCli(h(), ['admin', 'add', 'bob'])).code).toBe(EXIT.ok);
			const link = await runCli(h(), ['login-link', 'bob', '--ttl', '5m', '--json']);
			expect(link.code).toBe(EXIT.ok);
			const { url, login } = JSON.parse(link.stdout) as { url: string; login: string };
			expect(login.toLowerCase()).toBe('bob');
			const { cookie } = await consumeLoginLink(h(), url);
			const home = await h().fetchApp('/', { headers: { Cookie: cookie } });
			expect(home.status).toBeLessThan(500);
			// Links for non-admins are refused.
			expect((await runCli(h(), ['login-link', 'not-an-admin'])).code).not.toBe(EXIT.ok);
		},
		T
	);

	test('admin remove: the last admin cannot be removed', async () => {
		for (const l of ['bob', 'offline-admin']) expect((await runCli(h(), ['admin', 'remove', l])).code).toBe(EXIT.ok);
		expect((await runCli(h(), ['admin', 'remove', 'admin'])).code).toBe(EXIT.error);
	});

	test('config get returns what was set offline', async () => {
		const r = await runCli(h(), ['config', 'get', 'ui.greeting', '--json']);
		expect(r.code).toBe(EXIT.ok);
		expect(r.stdout).toContain('hello');
	});

	test('doctor --json reports its checks', async () => {
		const r = await runCli(h(), ['doctor', '--json']);
		expect([EXIT.ok, EXIT.error] as number[]).toContain(r.code);
		const checks = JSON.parse(r.stdout) as { name: string; ok: boolean }[] | { checks: { name: string; ok: boolean }[] };
		const list = Array.isArray(checks) ? checks : checks.checks;
		expect(list.length).toBeGreaterThan(3);
		expect(list.some((c) => /database|integrity/i.test(c.name) && c.ok)).toBe(true);
	});

	test('version works without a server', async () => {
		const r = await runCli(h(), ['version', '--json']);
		expect(r.code).toBe(EXIT.ok);
		expect(r.stdout).toContain('bun');
	});

	test(
		'socket-only commands exit 3 when no server runs; direct-mode commands still work',
		async () => {
			await h().killApp('SIGTERM');
			expect((await runCli(h(), ['github', 'status'])).code).toBe(EXIT.serverNotRunning);
			expect((await runCli(h(), ['admin', 'list', '--json'])).code).toBe(EXIT.ok);
			await h().restartApp();
		},
		T
	);
});

/**
 * The CLI without the harness's `--data`/`GRANARY_DATA_DIR` (ADR 0232): only
 * PATH, a scratch HOME and what the test passes.
 */
async function runBare(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['bun', cliEntry(), ...args], {
		cwd: ROOT,
		env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	return { code, stdout, stderr };
}

describe('granary CLI data dir (ADR 0232)', () => {
	const scratch = () => mkdtempSync(join(tmpdir(), 'granary-cli-'));

	test('a missing default data dir is refused and nothing is created', async () => {
		const home = scratch();
		const r = await runBare(['login-link', 'dhamidi'], { HOME: home, GRANARY_TEST_SYSTEM_DATA_DIR: join(home, 'no-such-system-dir') });
		expect(r.code).toBe(EXIT.dataDir);
		expect(r.stderr).toContain('does not exist');
		expect(r.stderr).toContain('per-user default');
		expect(readdirSync(home)).toEqual([]);
	});

	test('an existing but uninitialised data dir is refused and stays empty', async () => {
		const dir = scratch();
		for (const args of [['admin', 'add', 'alice'], ['login-link', 'alice'], ['config', 'get', 'github.mode'], ['doctor']]) {
			const r = await runBare([...args, '--data', dir], { HOME: scratch() });
			expect(r.code).toBe(EXIT.dataDir);
			expect(r.stderr).toContain('not initialised');
		}
		expect(readdirSync(dir)).toEqual([]);
	});

	test('the system data dir is used when it exists; GRANARY_DATA_DIR beats it', async () => {
		// The harness's initialised, running data dir plays /var/lib/granary.
		const viaSystem = await runBare(['admin', 'list', '--json'], { HOME: scratch(), GRANARY_TEST_SYSTEM_DATA_DIR: h().tmpDir });
		expect(viaSystem.code).toBe(EXIT.ok);
		expect(Array.isArray(JSON.parse(viaSystem.stdout))).toBe(true);
		const empty = scratch();
		const viaEnv = await runBare(['admin', 'list'], { HOME: scratch(), GRANARY_TEST_SYSTEM_DATA_DIR: h().tmpDir, GRANARY_DATA_DIR: empty });
		expect(viaEnv.code).toBe(EXIT.dataDir);
		expect(viaEnv.stderr).toContain('from GRANARY_DATA_DIR');
	});

	test.skipIf(process.getuid?.() === 0)('an inaccessible data dir fails with a sudo -u hint instead of falling back', async () => {
		const dir = scratch();
		writeFileSync(join(dir, DATA_DIR_LAYOUT.envFile), 'ORIGIN=https://granary.example.test\n');
		chmodSync(dir, 0o000);
		try {
			const r = await runBare(['admin', 'add', 'alice', '--data', dir], { HOME: scratch() });
			expect(r.code).toBe(EXIT.dataDir);
			expect(r.stderr).toContain('cannot access data dir');
			expect(r.stderr).toMatch(/sudo -u \S+ granary admin add alice --data /);
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	test('login-link refuses without ORIGIN and uses granary.env ORIGIN offline', async () => {
		const dir = join(scratch(), 'data');
		const home = scratch();
		expect((await runBare(['init', '--data', dir, '--yes-i-stored-the-key', '--json'], { HOME: home })).code).toBe(EXIT.ok);
		expect((await runBare(['admin', 'add', 'alice', '--data', dir], { HOME: home })).code).toBe(EXIT.ok);
		const refused = await runBare(['login-link', 'alice', '--data', dir], { HOME: home });
		expect(refused.code).toBe(EXIT.error);
		expect(refused.stderr).toContain('no ORIGIN configured');
		expect(refused.stdout).not.toContain('localhost');
		appendFileSync(join(dir, DATA_DIR_LAYOUT.envFile), '\nORIGIN=https://granary.example.test\n');
		const ok = await runBare(['login-link', 'alice', '--data', dir, '--json'], { HOME: home });
		expect(ok.code).toBe(EXIT.ok);
		expect((JSON.parse(ok.stdout) as { url: string }).url.startsWith('https://granary.example.test/auth/link/')).toBe(true);
	});
});
