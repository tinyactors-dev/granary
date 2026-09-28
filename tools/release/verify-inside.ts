/**
 * Runs INSIDE the clean `oven/bun` container for release:verify (ADR 0181).
 * Installs the packed tarball globally and exercises it like a new host would.
 * Writes /verify/out/result.json; never throws past the top level.
 */
import { mkdirSync } from 'node:fs';

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
const out = '/verify/out';
mkdirSync(out, { recursive: true });
const GLOBAL = `${process.env.HOME ?? '/root'}/.bun/install/global/node_modules`;
const PKG = `${GLOBAL}/@tinyactors/granary`;
const DATA = '/tmp/granary-data';
const PORT = 3999;

async function run(cmd: string[], env: Record<string, string> = {}, timeoutMs = 120_000) {
	const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
	const timer = setTimeout(() => p.kill(), timeoutMs);
	const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const code = await p.exited;
	clearTimeout(timer);
	return { code, text: (o + e).trim() };
}
const tail = (s: string, n = 600) => (s.length > n ? '…' + s.slice(-n) : s);

async function step(name: string, fn: () => Promise<Omit<Step, 'name'>>) {
	try {
		const r = await fn();
		steps.push({ name, ...r });
	} catch (e) {
		steps.push({ name, ok: false, detail: String(e instanceof Error ? e.message : e) });
	}
	const s = steps.at(-1)!;
	console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${name} — ${s.detail.split('\n')[0]}`);
}

async function waitHttp(url: string, ms: number): Promise<{ status: number; body: string } | null> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
			return { status: r.status, body: (await r.text()).slice(0, 400) };
		} catch {
			await Bun.sleep(500);
		}
	}
	return null;
}

await step('bun version', async () => ({ ok: true, detail: `${Bun.version} on ${process.platform}/${process.arch}` }));

await step('install tarball globally', async () => {
	const r = await run(['bun', 'add', '-g', '/pkg/granary.tgz'], {}, 300_000);
	return { ok: r.code === 0, detail: r.code === 0 ? 'bun add -g ok' : tail(r.text) };
});

await step('native addon loads', async () => {
	const r = await run(['bun', '-e', `const t=require(${JSON.stringify(PKG + '/node_modules/@tinyactors/node')});const s=t.createSystem({clock:'manual'});console.log(t.version);s.close()`]);
	if (r.code === 0) return { ok: true, detail: `@tinyactors/node ${r.text}` };
	// hoisted into the global node_modules instead of nested
	const r2 = await run(['bun', '-e', `const t=require(${JSON.stringify(GLOBAL + '/@tinyactors/node')});const s=t.createSystem({clock:'manual'});console.log(t.version);s.close()`]);
	return { ok: r2.code === 0, detail: r2.code === 0 ? `@tinyactors/node ${r2.text}` : tail(r.text + '\n' + r2.text) };
});

await step('granary version', async () => {
	const r = await run(['granary', 'version']);
	return { ok: r.code === 0, detail: r.code === 0 ? r.text.split('\n')[0]! : tail(r.text) };
});

// Everything comes from the data dir `granary init` writes (master key,
// granary.env); only NODE_ENV is set.
const cliEnv: Record<string, string> = { NODE_ENV: 'production' };

await step('granary init', async () => {
	// init generates the master key itself (ADR 0157); confirmation skipped non-interactively
	const r = await run(['granary', 'init', '--data', DATA, '--origin', `http://127.0.0.1:${PORT}`, '--yes-i-stored-the-key'], cliEnv);
	return { ok: r.code === 0, detail: r.code === 0 ? 'initialised ' + DATA : tail(r.text) };
});

mkdirSync(DATA, { recursive: true });
const server = Bun.spawn(['granary', 'serve', '--data', DATA, '--host', '127.0.0.1', '--port', String(PORT)], {
	env: { ...process.env, ...cliEnv },
	stdout: 'pipe',
	stderr: 'pipe'
});
let serverLog = '';
(async () => {
	for await (const c of server.stdout) serverLog += new TextDecoder().decode(c);
})();
(async () => {
	for await (const c of server.stderr) serverLog += new TextDecoder().decode(c);
})();

await step('granary serve starts', async () => {
	const r = await waitHttp(`http://127.0.0.1:${PORT}/`, 60_000);
	if (!r) return { ok: false, detail: 'no HTTP answer within 60 s\n' + tail(serverLog) };
	return { ok: r.status < 500, detail: `GET / → ${r.status}` };
});

for (const path of ['/healthz', '/readyz']) {
	await step(`GET ${path}`, async () => {
		const r = await waitHttp(`http://127.0.0.1:${PORT}${path}`, path === '/readyz' ? 30_000 : 5_000);
		if (!r) return { ok: false, detail: 'no answer' };
		if (path === '/readyz' && r.status === 503) {
			// wait for readiness a bit longer
			const until = Date.now() + 30_000;
			while (Date.now() < until) {
				const again = await waitHttp(`http://127.0.0.1:${PORT}${path}`, 2000);
				if (again?.status === 200) return { ok: true, detail: `200 ${again.body.slice(0, 120)}` };
				await Bun.sleep(1000);
			}
		}
		return { ok: r.status === 200, detail: `${r.status} ${r.body.slice(0, 120)}` };
	});
}

await step('granary doctor', async () => {
	const r = await run(['granary', 'doctor', '--data', DATA], cliEnv);
	return { ok: r.code === 0, detail: tail(r.text, 300) };
});

await step('server stops on SIGTERM', async () => {
	server.kill('SIGTERM');
	const code = await Promise.race([server.exited, Bun.sleep(20_000).then(() => 'timeout' as const)]);
	if (code === 'timeout') {
		server.kill('SIGKILL');
		return { ok: false, detail: 'did not exit within 20 s' };
	}
	return { ok: true, detail: `exited (${code})` };
});

const ok = steps.every((s) => s.ok);
await Bun.write(`${out}/result.json`, JSON.stringify({ platform: `${process.platform}/${process.arch}`, ok, steps, serverLogTail: tail(serverLog, 2000) }, null, 2));
console.log(ok ? 'VERIFY OK' : 'VERIFY NOT OK');
process.exit(ok ? 0 : 1); // don't linger on open handles; the container ends here
