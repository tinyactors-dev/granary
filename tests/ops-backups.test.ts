/**
 * Ops backups against fake-infra (ADR 0091/0103 successors, ADR 0150):
 * backup → upload → manifest → restore drill; faults and retries;
 * bad credentials; unencrypted objects refused; `ops:restore` round trip.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { OPS_TEST, ROOT, useHarness } from './harness';
import { FakeInfraClient, OpsClient, OPS_SERVICE, artifactsOf, manifestsByRun } from './ops';

const h = useHarness({ infra: true });
const ops = () => new OpsClient(h());
const infra = () => new FakeInfraClient(h().infraUrl);

afterEach(async () => {
	await infra().clearFaults();
});

/** Newest run per database (runs are listed newest first). */
async function latestRuns() {
	const runs = await ops().runs();
	const by = new Map<string, (typeof runs)[number]>();
	for (const r of runs) if (!by.has(r.database)) by.set(r.database, r);
	return by;
}

async function backupAndWait(expect: 'succeeded' | 'partial' = 'succeeded') {
	const started = await ops().backupNow();
	const ids = started.map((r) => r.id);
	return h().waitFor(
		async () => {
			const runs = (await ops().runs()).filter((r) => ids.includes(r.id));
			return runs.length === ids.length && runs.every((r) => r.state === expect) ? runs : null;
		},
		{ timeout: 30_000, message: `runs ${ids.join(', ')} to become ${expect}` }
	);
}

function runRestore(args: string[]) {
	const p = Bun.spawnSync(['bun', 'src/lib/ops/cli/restore.ts', ...args, '--json'], {
		cwd: ROOT,
		env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GRANARY_MASTER_KEY: OPS_TEST.masterKey }
	});
	const out = p.stdout.toString().trim().split('\n').pop() ?? '';
	return { code: p.exitCode, json: out ? (JSON.parse(out) as Record<string, unknown>) : {}, stderr: p.stderr.toString() };
}

describe('ops backups', () => {
	test('boot backup reaches R2 and the local copy, commits manifests, and a drill passes', async () => {
		const runs = await h().waitFor(
			async () => {
				const latest = await latestRuns();
				const all = ['granary', 'ops'].map((d) => latest.get(d));
				return all.every((r) => r?.state === 'succeeded') ? all : null;
			},
			{ timeout: 30_000, message: 'boot runs of granary and ops to succeed' }
		);
		for (const r of runs) {
			expect(r!.destinations.map((d) => d.state).sort()).toEqual(['done', 'done']);
		}
		const manifests = manifestsByRun(await infra().objects());
		for (const r of runs) expect(manifests.get(r!.id)?.length).toBe(1);

		const drill = await ops().drillNow('seed-r2');
		expect(drill.destinationId).toBe('seed-r2');
		const drills = await h().waitFor(
			async () => {
				const d = (await ops().drills()).filter((x) => x.destinationId === 'seed-r2' && x.finishedAt !== null);
				return d.length >= 2 ? d : null;
			},
			{ message: 'drills of both databases on seed-r2' }
		);
		expect(drills.every((d) => d.result === 'ok')).toBe(true);

		// Observed through ops' own traces too.
		await h().waitForSpan((s) => s.service === OPS_SERVICE && s.name.includes('store.manifest-committed'), { message: 'granary-ops span for a committed manifest' });
		await h().waitForSpan((s) => s.service === OPS_SERVICE && s.name.includes('drill.checked'), { message: 'granary-ops span for a drill check' });
		const status = await ops().status();
		expect(status.lastDrill?.result).toBe('ok');
	}, 60_000);

	test('ops:restore round-trips the latest backup with integrity_check and matching row counts', async () => {
		const out = join(h().tmpDir, 'restored.sqlite');
		const r = runRestore(['--ops-db', join(h().tmpDir, 'ops.sqlite'), '--dest', 'seed-r2', '--database', 'granary', '--latest', '--out', out]);
		expect(r.code, r.stderr).toBe(0);
		expect(r.json.ok).toBe(true);
		const db = new Database(out, { readonly: true });
		expect((db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
		const run = await ops().run(String(r.json.runId));
		for (const [table, n] of Object.entries(run!.manifest!.rowCounts)) {
			expect((db.query(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n).toBe(n);
		}
		db.close();
	}, 60_000);

	test('upload faults (more than the S3 client retries) are retried until the upload succeeds', async () => {
		const id = await infra().fault({ target: 's3', method: 'PUT', pathPattern: 'granary/granary/.*\\.sqlite\\.zst\\.aesgcm', status: 500, s3Code: 'InternalError', count: 5 });
		const runs = await backupAndWait('succeeded');
		const state = await infra().state();
		expect(state.faults.find((f) => f.id === id)?.remaining ?? 0).toBe(0);
		const granary = runs.find((r) => r.database === 'granary')!;
		const detail = await ops().run(granary.id);
		const r2 = detail!.uploads.find((u) => u.destinationId === 'seed-r2')!;
		expect(r2.state).toBe('done');
		expect(r2.attempts).toBeGreaterThan(1);
		expect(manifestsByRun(await infra().objects()).get(granary.id)?.length).toBe(1);
	}, 60_000);

	test('bad credentials: run is partial, destination-auth needs attention, fixing them recovers', async () => {
		await infra().fault({ target: 's3', method: '*', pathPattern: '.', status: 403, s3Code: 'InvalidAccessKeyId', count: 1_000_000 });
		await backupAndWait('partial');
		const cond = await h().waitFor(
			async () => {
				const c = await ops().condition('destination-auth.seed-r2');
				return c && (c.state === 'attention' || c.state === 'healing') ? c : null;
			},
			{ timeout: 20_000, message: 'destination-auth.seed-r2 to need attention' }
		);
		expect(cond.kind).toBe('destination-auth');
		expect((await ops().status()).sleepOk).toBe(false);

		await infra().clearFaults();
		await backupAndWait('succeeded');
		await h().waitFor(async () => (await ops().condition('destination-auth.seed-r2'))?.state === 'ok', {
			timeout: 20_000,
			message: 'destination-auth.seed-r2 back to ok'
		});
	}, 90_000);

	test('an unencrypted backup is refused by ops:restore', async () => {
		const latest = (await latestRuns()).get('granary')!;
		const manifest = (await ops().run(latest.id))!.manifest!;
		const runId = `plain-${Date.now().toString(36)}`;
		// The manifest's artifactKey is relative to the destination prefix (`granary/`).
		const artifactKey = manifest.artifactKey.replace(latest.id, runId);
		const objectKey = `granary/${artifactKey}`;
		const { encryption: _drop, ...plain } = manifest as typeof manifest & { encryption?: unknown };
		const now = Date.now();
		await infra().seedObjects([
			{ key: objectKey, bytes: 16, lastModified: now, body: 'SQLite format 3\u0000' },
			{ key: `${objectKey}.manifest.json`, bytes: 0, lastModified: now, body: JSON.stringify({ ...plain, runId, artifactKey }) }
		]);
		const r = runRestore(['--ops-db', join(h().tmpDir, 'ops.sqlite'), '--dest', 'seed-r2', '--database', 'granary', '--run', runId, '--out', join(h().tmpDir, 'plain.sqlite')]);
		expect(r.code, JSON.stringify(r.json) + r.stderr).toBe(2);
		expect(String(r.json.error)).toContain('not-encrypted');
	}, 30_000);

	test('artifacts in the bucket are encrypted and never plaintext SQLite', async () => {
		for (const o of artifactsOf(await infra().objects())) expect(o.size).toBeGreaterThan(0);
		const leaked = h().collector.raw.some((r) => Buffer.from(r.bytes).includes('SQLite format 3'));
		expect(leaked).toBe(false);
	});
});

