/**
 * Ops crash safety (ADR 0082 successors, ADR 0150): SIGKILL the app while an
 * upload is in flight, and between the artifact and its manifest; after a
 * restart every run commits exactly one manifest.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { useHarness } from './harness';
import { FakeInfraClient, OpsClient, manifestsByRun } from './ops';

const h = useHarness({ infra: true });
const ops = () => new OpsClient(h());
const infra = () => new FakeInfraClient(h().infraUrl);

afterEach(async () => {
	await infra().clearFaults();
});

const ARTIFACT = 'granary/granary/.*\\.sqlite\\.zst\\.aesgcm';

async function waitRunsTerminal(ids: string[]) {
	return h().waitFor(
		async () => {
			const runs = (await ops().runs()).filter((r) => ids.includes(r.id));
			return runs.length === ids.length && runs.every((r) => r.state === 'succeeded') ? runs : null;
		},
		{ timeout: 45_000, message: `runs ${ids.join(', ')} to succeed after restart` }
	);
}

async function assertOneManifestEach(ids: string[]) {
	const manifests = manifestsByRun(await infra().objects());
	for (const id of ids) expect(manifests.get(id)?.length ?? 0).toBe(1);
}

describe('ops crash safety', () => {
	test('SIGKILL mid-upload → the upload resumes after restart; one manifest per run', async () => {
		// Let the boot runs finish first so only the manual run is in flight.
		await h().waitFor(async () => (await ops().runs()).filter((r) => r.state === 'succeeded').length >= 2, { timeout: 30_000, message: 'boot runs' });
		await infra().fault({ target: 's3', method: 'PUT', pathPattern: ARTIFACT, latencyMs: 4000, count: 1 });
		const started = await ops().backupNow();
		const granary = started.find((r) => r.database === 'granary')!;
		await h().waitFor(async () => (await infra().state()).requests.some((q) => q.faultId !== null) || (await infra().state()).faults.every((f) => f.remaining === 0), {
			message: 'the slow artifact PUT to start'
		});
		await h().restartApp({ kill: 'SIGKILL' });

		const runs = await waitRunsTerminal(started.map((r) => r.id));
		expect(runs.find((r) => r.id === granary.id)!.destinations.every((d) => d.state === 'done')).toBe(true);
		await assertOneManifestEach(started.map((r) => r.id));
	}, 90_000);

	test('SIGKILL between artifact and manifest → the artifact is reused and the manifest committed once', async () => {
		await infra().fault({ target: 's3', method: 'PUT', pathPattern: 'granary/granary/.*\\.manifest\\.json', status: 503, s3Code: 'ServiceUnavailable', count: 1_000_000 });
		const started = await ops().backupNow();
		const granary = started.find((r) => r.database === 'granary')!;
		// Wait until the artifact is in the bucket but the manifest keeps failing.
		await h().waitFor(
			async () => {
				const s = await infra().state();
				const hasArtifact = s.buckets.some((b) => b.objects.some((o) => o.key.includes(granary.id) && o.key.endsWith('.aesgcm')));
				const manifestFailed = s.requests.some((q) => q.path.includes(granary.id) && q.path.includes('.manifest.json') && q.status >= 500);
				return hasArtifact && manifestFailed;
			},
			{ timeout: 20_000, message: 'artifact stored and manifest PUT failing' }
		);
		await h().restartApp({ kill: 'SIGKILL' });
		const killedAt = Date.now();
		await infra().clearFaults();

		await waitRunsTerminal(started.map((r) => r.id));
		await assertOneManifestEach(started.map((r) => r.id));
		// The artifact stored before the crash is reused, not uploaded again.
		const rewrites = (await infra().state()).requests.filter(
			(q) => q.at > killedAt && q.method === 'PUT' && q.path.includes(granary.id) && /\.aesgcm(\?|$)/.test(q.path) && q.status < 300
		);
		expect(rewrites.length).toBe(0);
	}, 90_000);
});
