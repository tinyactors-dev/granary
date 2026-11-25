/**
 * The sandbox through production (ADR 0315): a production granary (the
 * harness app) serves the sandbox on this machine to its admins who enter
 * it, and the fake GitHub's pages under /__sandbox/github. The sandbox runs
 * the whole simulation (fake GitHub, fake-infra, load generator) on
 * 127.0.0.1; production's own data and fake GitHub are untouched.
 *
 * The sandbox runs as child processes this file owns (built CLI and app).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { cliEntry, freePort, runCli, useHarness, type Harness } from './harness';
import { consumeLoginLink, cookiesOf, remoteCall } from './github-app';
import { EXIT } from '../src/lib/schemas/cli';

const T = 90_000;
const tmp = mkdtempSync(join(tmpdir(), 'granary-sandbox-proxy-'));
const dataDir = join(tmp, 'sandbox');
const ports = { app: freePort(), github: freePort(), infra: freePort(), loadgen: freePort() };
const sandboxUrl = `http://127.0.0.1:${ports.app}`;
const sandboxGithub = `http://127.0.0.1:${ports.github}`;
const children: Subprocess[] = [];

const h: () => Harness = useHarness({ appEnv: { GRANARY_SANDBOX_URL: sandboxUrl } });

const cleanEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: tmp, NODE_ENV: 'production' });
async function cli(args: string[]) {
	const proc = Bun.spawn(['bun', cliEntry(), ...args], { cwd: tmp, env: cleanEnv(), stdout: 'pipe', stderr: 'pipe' });
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

/** A cookie header without `name`, plus `extra`. */
const jar = (...parts: string[]) => parts.filter(Boolean).join('; ');

let admin = '';

beforeAll(async () => {
	const init = await cli([
		'sandbox', 'init', '--data', dataDir, '--via', h().appUrl,
		'--port', String(ports.app), '--github-port', String(ports.github), '--infra-port', String(ports.infra), '--loadgen-port', String(ports.loadgen), '--json'
	]);
	if (init.code !== EXIT.ok) throw new Error(`sandbox init: ${init.stderr}`);
	const proc = Bun.spawn(['bun', cliEntry(), 'sandbox', 'serve', '--data', dataDir], { cwd: tmp, env: cleanEnv(), stdout: 'pipe', stderr: 'pipe' });
	children.push(proc);
	await until(async () => ((await fetch(`${sandboxUrl}/readyz`)).ok ? true : null), 'the sandbox to be ready', 60_000);
	await until(async () => {
		const s = (await (await fetch(`${sandboxGithub}/__control/state`)).json()) as { apps?: unknown[] };
		return s.apps?.length ? true : null;
	}, 'the sandbox to connect to its fake GitHub');
	const link = await runCli(h(), ['login-link', 'admin', '--json']);
	admin = (await consumeLoginLink(h(), (JSON.parse(link.stdout) as { url: string }).url)).cookie;
}, T);

afterAll(async () => {
	for (const c of children) c.kill('SIGTERM');
	await Promise.all(children.map((c) => c.exited));
	rmSync(tmp, { recursive: true, force: true });
});

describe('sandbox through production', () => {
	test('the sandbox runs the whole simulation on 127.0.0.1, says it is a sandbox, and production is not one', async () => {
		expect(((await (await fetch(`http://127.0.0.1:${ports.loadgen}/api/status`)).json()) as { ok: boolean }).ok).toBe(true);
		expect((await fetch(`http://127.0.0.1:${ports.infra}/healthz`)).ok).toBe(true);
		const health = (await (await fetch(`${sandboxUrl}/healthz`)).json()) as { sandbox: boolean };
		expect(health.sandbox).toBe(true);
		expect(((await (await h().fetchApp('/healthz')).json()) as { sandbox: boolean }).sandbox).toBe(false);
		const lan = Object.values((await import('node:os')).networkInterfaces())
			.flat()
			.find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
		if (lan) {
			for (const p of [ports.app, ports.github, ports.infra, ports.infra + 1, ports.infra + 2, ports.loadgen]) {
				await expect(fetch(`http://${lan}:${p}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
			}
		}
	}, T);

	test('nobody but a production admin gets through, and a stale sandbox cookie is dropped', async () => {
		const anon = await h().fetchApp('/__sandbox/github/', { redirect: 'manual' });
		expect(await anon.text()).not.toContain('Fake GitHub</h1>');
		const stale = await h().fetchApp('/admin/sessions', { headers: { Cookie: 'granary_sandbox=1' }, redirect: 'manual' });
		expect(await stale.text()).not.toContain('data-testid="sandbox-strip"');
		expect(stale.headers.getSetCookie().join('\n')).toMatch(/granary_sandbox=;/);
	}, T);

	test('an admin enters the sandbox, signs in there, and is served by it until leaving', async () => {
		const entered = await remoteCall(h(), admin, '/admin/sandbox', 'enterSandbox', undefined);
		expect(entered.result).toEqual({ next: '/admin/sessions' });
		const sandboxCookie = cookiesOf(entered.response);
		expect(sandboxCookie).toBe('granary_sandbox=1');
		const inside = jar(admin, sandboxCookie);

		const page = await (await h().fetchApp('/admin/sessions', { headers: { Cookie: inside } })).text();
		expect(page).toContain('data-testid="sandbox-strip"');
		expect(page).toContain('data-testid="sandbox-leave"');
		// Production keeps its probes even inside the sandbox.
		expect(((await (await h().fetchApp('/healthz', { headers: { Cookie: inside } })).json()) as { sandbox: boolean }).sandbox).toBe(false);

		// Sign in to the sandbox through production: a sandbox login link, consumed on production's origin.
		const link = await cli(['login-link', 'admin', '--json', '--data', dataDir]);
		expect(link.code).toBe(EXIT.ok);
		const path = new URL((JSON.parse(link.stdout) as { url: string }).url);
		const confirm = await h().fetchApp(path.pathname + path.search, { headers: { Cookie: inside } });
		expect(confirm.status).toBe(200);
		const posted = await h().fetchApp(path.pathname + path.search, {
			method: 'POST',
			headers: { Cookie: inside, Origin: h().appUrl, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
			body: '',
			redirect: 'manual'
		});
		expect(posted.status).toBe(303);
		expect(posted.headers.get('location')?.startsWith('/')).toBe(true);
		const sandboxSession = cookiesOf(posted);
		expect(sandboxSession).toContain('granary_sandbox_session=');
		expect(sandboxSession).not.toContain('granary_session=');
		const both = jar(inside, sandboxSession);

		// Signed in to the sandbox: its admin pages, its own Fake GitHub area.
		const fakeArea = await (await h().fetchApp('/admin/github', { headers: { Cookie: both } })).text();
		expect(fakeArea).toContain('data-testid="sandbox-strip"');
		expect(fakeArea).not.toContain('data-testid="admin-unavailable"');

		// Leaving clears the cookie and goes back to production's Admin → Sandbox.
		const left = await h().fetchApp('/__sandbox/leave', { headers: { Cookie: both }, redirect: 'manual' });
		expect(left.status).toBe(303);
		expect(left.headers.get('location')).toBe('/admin/sandbox');
		expect(left.headers.getSetCookie().join('\n')).toMatch(/granary_sandbox=;/);
		const back = await (await h().fetchApp('/admin/sandbox', { headers: { Cookie: jar(admin, sandboxSession) } })).text();
		expect(back).not.toContain('data-testid="sandbox-strip"');
	}, T);

	test('the fake GitHub is played through production, its links open there, and production is untouched', async () => {
		const owner = 'sandbox-org';
		const repo = `demo-${Date.now()}`;
		// A JSON POST from production's pages, through production, to the sandbox's fake GitHub.
		const opened = await h().fetchApp('/__sandbox/github/__control/issues', {
			method: 'POST',
			headers: { Cookie: admin, Origin: h().appUrl, 'Content-Type': 'application/json' },
			body: JSON.stringify({ owner, repo, title: 'hello from a stranger', author: 'stranger-danger' })
		});
		expect(opened.status).toBe(200);
		const { number } = (await opened.json()) as { number: number };
		// The sandbox granary closes it on its fake GitHub (not allowlisted).
		const issue = await until(async () => {
			const s = (await (await fetch(`${sandboxGithub}/__control/state`)).json()) as { issues: { owner: string; repo: string; number: number; state: string; html_url?: string }[] };
			const i = s.issues.find((x) => x.repo === repo && x.number === number);
			return i?.state === 'closed' ? i : null;
		}, 'the sandbox to close the stranger\'s issue');
		expect(issue.state).toBe('closed');
		// Its page opens on production's origin.
		const thread = await h().fetchApp(`/__sandbox/github/${owner}/${repo}/issues/${number}`, { headers: { Cookie: admin } });
		expect(thread.status).toBe(200);
		expect(await thread.text()).toContain('hello from a stranger');
		// A cross-site POST is refused before it reaches the sandbox.
		const csrf = await h().fetchApp('/__sandbox/github/__control/issues', {
			method: 'POST',
			headers: { Cookie: admin, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
			body: JSON.stringify({ owner, repo, title: 'x', author: 'y' })
		});
		expect(csrf.status).toBe(403);
		// Production's own fake GitHub never heard of it.
		const prod = await h().fakeGithub.state();
		expect(prod.issues.some((i) => i.repo === repo)).toBe(false);
	}, T);

	test('the sandbox links GitHub pages to production\'s origin', async () => {
		const env = await Bun.file(join(dataDir, 'granary.env')).text();
		expect(env).toContain(`FAKE_GITHUB_WEB_URL=${h().appUrl}/__sandbox/github`);
		expect(env).toContain(`GRANARY_GITHUB_PAGES_URL=${h().appUrl}/__sandbox/github`);
		expect(env).toContain(`GRANARY_SEED_R2_ENDPOINT_OVERRIDE=http://localhost:${ports.infra}/s3/eu`);
	});
});
