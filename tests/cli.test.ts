/**
 * The `granary` CLI against a running server and offline (ADR 0159, 0161,
 * 0203): init, admins, login links, config, doctor, exit codes.
 *
 * `todo` until E1's CLI is in the tree and in `build/` (flip LIVE).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, useHarness, type Harness } from './harness';
import { consumeLoginLink } from './github-app';
import { EXIT, DATA_DIR_LAYOUT } from '../src/lib/schemas/cli';

const LIVE = process.env.GRANARY_TEST_PENDING === '1';
const live = LIVE ? test : test.todo;
const T = 60_000;

let initOutput: { code: number; stdout: string; stderr: string } | null = null;

const h: () => Harness = !LIVE
	? () => {
			throw new Error('not live');
		}
	: useHarness({
			appEnv: { ADMINS: 'admin' },
			/** Offline commands run before the server starts. */
			prepare: async (harness) => {
				// Blank the harness's OPS_MASTER_KEY so init generates (and prints) a new key instead of using the env one (ADR 0157).
				initOutput = await runCli(harness, ['init', '--origin', harness.appUrl, '--yes-i-stored-the-key', '--json'], { env: { OPS_MASTER_KEY: '' } });
				const key = /[0-9a-f]{64}/i.exec(initOutput.stdout)?.[0];
				if (key) harness.extraAppEnv.GRANARY_MASTER_KEY = key;
				await runCli(harness, ['admin', 'add', 'offline-admin']);
				await runCli(harness, ['config', 'set', 'ui.greeting', 'hello']);
			}
		});

describe('granary CLI', () => {
	live('init (offline) creates a private data dir, prints the key once and writes granary.env', () => {
		expect(initOutput?.code).toBe(EXIT.ok);
		expect(initOutput!.stdout).toMatch(/[0-9a-f]{64}/i);
		const mode = statSync(h().tmpDir).mode & 0o777;
		expect(mode).toBe(0o700);
		expect(existsSync(join(h().tmpDir, DATA_DIR_LAYOUT.envFile))).toBe(true);
	});

	live('init refuses while the server runs', async () => {
		const r = await runCli(h(), ['init', '--yes-i-stored-the-key']);
		expect(r.code).not.toBe(EXIT.ok);
	});

	live('admin list (socket) shows seeded and offline-added admins', async () => {
		expect(existsSync(join(h().tmpDir, DATA_DIR_LAYOUT.adminSocket))).toBe(true);
		const r = await runCli(h(), ['admin', 'list', '--json']);
		expect(r.code).toBe(EXIT.ok);
		const logins = (JSON.parse(r.stdout) as { login: string }[]).map((a) => a.login.toLowerCase());
		expect(logins).toEqual(expect.arrayContaining(['admin', 'offline-admin']));
	});

	live(
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

	live('admin remove: the last admin cannot be removed', async () => {
		for (const l of ['bob', 'offline-admin']) expect((await runCli(h(), ['admin', 'remove', l])).code).toBe(EXIT.ok);
		expect((await runCli(h(), ['admin', 'remove', 'admin'])).code).toBe(EXIT.error);
	});

	live('config get returns what was set offline', async () => {
		const r = await runCli(h(), ['config', 'get', 'ui.greeting', '--json']);
		expect(r.code).toBe(EXIT.ok);
		expect(r.stdout).toContain('hello');
	});

	live('doctor --json reports its checks', async () => {
		const r = await runCli(h(), ['doctor', '--json']);
		expect([EXIT.ok, EXIT.error] as number[]).toContain(r.code);
		const checks = JSON.parse(r.stdout) as { name: string; ok: boolean }[] | { checks: { name: string; ok: boolean }[] };
		const list = Array.isArray(checks) ? checks : checks.checks;
		expect(list.length).toBeGreaterThan(3);
		expect(list.some((c) => /database|integrity/i.test(c.name) && c.ok)).toBe(true);
	});

	live('version works without a server', async () => {
		const r = await runCli(h(), ['version', '--json']);
		expect(r.code).toBe(EXIT.ok);
		expect(r.stdout).toContain('bun');
	});

	live(
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
