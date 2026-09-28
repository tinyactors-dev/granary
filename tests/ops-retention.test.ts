/**
 * Bounded retention and the egress budget (ADR 0096, 0098, 0107, 0150).
 * - 200 synthetic aged backups (400 MB each, far over the 8 GiB cap) converge
 *   under the caps; the newest real backups (the floor) survive.
 * - A large DB and a 1 GiB/month budget stretch the backup interval.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { useHarness } from './harness';
import { FakeInfraClient, OpsClient, manifestsByRun } from './ops';

const GiB = 1024 ** 3;
const DAY = 86_400_000;

const h = useHarness({
	infra: true,
	// ~3 MB of incompressible data, so each sealed backup is ~3 MB (egress projection).
	prepare: (hh) => {
		const db = new Database(hh.databasePath, { create: true });
		db.run('CREATE TABLE IF NOT EXISTS test_filler (id INTEGER PRIMARY KEY, blob BLOB)');
		const ins = db.prepare('INSERT INTO test_filler (blob) VALUES (?)');
		for (let i = 0; i < 48; i++) ins.run(crypto.getRandomValues(new Uint8Array(64 * 1024)));
		db.close();
	}
});
const ops = () => new OpsClient(h());
const infra = () => new FakeInfraClient(h().infraUrl);

describe('ops retention and budgets', () => {
	test('synthetic aged backups over the cap converge under it; the newest real backups survive', async () => {
		const real = await h().waitFor(
			async () => {
				const r = (await ops().runs()).filter((x) => x.database === 'granary' && x.state === 'succeeded');
				return r.length ? r : null;
			},
			{ timeout: 30_000, message: 'a real granary backup' }
		);
		const now = Date.now();
		const objects = [];
		for (let i = 1; i <= 200; i++) {
			const at = now - i * DAY;
			const d = new Date(at);
			const key = `granary/granary/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/syn-${i}.sqlite.zst.aesgcm`;
			objects.push({ key, bytes: 400 * 1024 ** 2, lastModified: at }, { key: `${key}.manifest.json`, bytes: 512, lastModified: at });
		}
		await infra().seedObjects(objects);

		// The retention actor runs every GRANARY_TEST_RETENTION_INTERVAL_MS (2 s in tests).
		const settled = await h().waitFor(
			async () => {
				const objs = (await infra().objects()).filter((o) => o.key.startsWith('granary/granary/'));
				const manifests = manifestsByRun(objs);
				const bytes = objs.reduce((n, o) => n + o.size, 0);
				return manifests.size <= 82 && bytes <= 8 * GiB ? { objs, manifests, bytes } : null;
			},
			{ timeout: 45_000, interval: 500, message: 'granary backups under 82 and 8 GiB' }
		);
		expect(settled.manifests.size).toBeGreaterThanOrEqual(1);
		for (const r of real.slice(0, 3)) expect(settled.manifests.has(r.id)).toBe(true);
	}, 90_000);

	test('a 1 GiB/month egress budget stretches the backup interval', async () => {
		const res = await h().fetchApp('/__dev/api/ops/budgets', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ r2EgressBytesPerMonth: GiB })
		});
		expect(res.status).toBe(200);
		const ids = (await ops().backupNow()).map((r) => r.id);
		await h().waitFor(async () => (await ops().runs()).filter((r) => ids.includes(r.id)).every((r) => r.state === 'succeeded'), {
			timeout: 30_000,
			message: 'manual runs'
		});
		const plan = await h().waitFor(
			async () => {
				const p = (await ops().plans()).find((x) => x.id === 'seed-all');
				return p && p.effectiveIntervalMs > p.intervalMs ? p : null;
			},
			{ timeout: 20_000, message: 'plan seed-all interval stretched' }
		);
		expect(plan.effectiveIntervalMs).toBeGreaterThan(plan.intervalMs);
		const events = await ops().events();
		expect(events.some((e) => e.kind === 'handled' && /interval stretched/.test(e.message))).toBe(true);
	}, 60_000);
});
