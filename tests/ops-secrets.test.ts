/**
 * Secret-leak check (ADR 0086, 0093, 0150): after backups, drills and page
 * views, no secret value appears in exported telemetry, app logs, /ops pages
 * or ops.sqlite in plaintext.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPS_TEST, useHarness, type Harness } from './harness';
import { OpsClient } from './ops';

const h = useHarness({ infra: true });
const ops = () => new OpsClient(h());

const SECRETS = [OPS_TEST.secretAccessKey, OPS_TEST.masterKey, Buffer.from(OPS_TEST.masterKey, 'hex').toString('base64')];

/** Sign in through the fake GitHub's OAuth (see oauth.test.ts); returns a Cookie header. */
async function signIn(h: Harness, login: string): Promise<string> {
	const jar = new Map<string, string>();
	const take = (res: Response) => {
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(';');
			const eq = pair!.indexOf('=');
			jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
		}
	};
	const start = await h.fetchApp('/auth/login?redirect=/ops');
	take(start);
	const authorize = new URL(start.headers.get('location')!);
	authorize.searchParams.set('login', login);
	const approved = await fetch(authorize, { redirect: 'manual' });
	const callback = new URL(approved.headers.get('location')!);
	const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
	take(await h.fetchApp(callback.pathname + callback.search, { headers: { cookie: header() } }));
	return header();
}

function findLeaks(where: string, haystack: string | Uint8Array): string[] {
	const buf = typeof haystack === 'string' ? Buffer.from(haystack) : Buffer.from(haystack);
	return SECRETS.filter((s) => buf.includes(s)).map((s) => `${where} contains …${s.slice(-6)}`);
}

describe('ops secrets never leak', () => {
	test('telemetry, logs, pages and ops.sqlite contain no secret values', async () => {
		await h().waitFor(async () => (await ops().runs()).filter((r) => r.state === 'succeeded').length >= 2, { timeout: 30_000, message: 'boot runs' });
		await ops().drillNow('seed-r2');
		await h().waitFor(async () => (await ops().drills()).some((d) => d.finishedAt !== null), { message: 'a finished drill' });
		// Uploads and the drill reveal the R2 secret inside the I/O processor; it must stay there.
		const cookie = await signIn(h(), 'admin');
		const leaks: string[] = [];
		for (const path of ['/ops', '/ops/secrets', '/ops/destinations', '/ops/destinations/seed-r2', '/ops/telemetry', '/ops/backups']) {
			const res = await h().fetchApp(path, { headers: { cookie } });
			expect(res.status, path).toBe(200);
			const html = await res.text();
			// Signed in for real: the secrets page lists the seeded secret by name (never by value).
			if (path === '/ops/secrets') expect(html).toContain('R2 secret access key (seed)');
			leaks.push(...findLeaks(`page ${path}`, html));
		}
		await Bun.sleep(2500); // let the sinks flush
		for (const r of h().collector.raw) leaks.push(...findLeaks(`OTLP ${r.path}`, r.bytes));
		leaks.push(...findLeaks('app output', h().appOutput.lines.join('\n')));
		for (const f of ['ops.sqlite', 'ops.sqlite-wal']) {
			const p = join(h().tmpDir, f);
			if (existsSync(p)) leaks.push(...findLeaks(f, readFileSync(p)));
		}
		expect(h().collector.raw.length).toBeGreaterThan(0);
		expect(leaks).toEqual([]);
	}, 60_000);
});
