/**
 * Ops telemetry through the exe.dev proxy stand-in (ADR 0099, 0121, 0150):
 * the seeded sink delivers with an exe VM token; when the proxy fails the
 * sink buffers/drops with counters, the condition goes to healing/attention,
 * and it recovers once the proxy is back.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { useHarness } from './harness';
import { FakeInfraClient, OpsClient, OPS_SERVICE } from './ops';

const h = useHarness({ infra: true, opsSink: 'exe-token' });
const ops = () => new OpsClient(h());
const infra = () => new FakeInfraClient(h().infraUrl);
const SINK = 'seed-otlp';
const COND = `telemetry-sink-down.${SINK}`;

afterEach(async () => {
	await infra().clearFaults();
});

describe('ops telemetry', () => {
	test('granary and granary-ops telemetry arrive through the exe.dev token front', async () => {
		// The sink merges queued batches (granary + granary-ops) into one POST per
		// flush; fake-infra labels a POST with its first resource's service.
		const batches = await h().waitFor(
			async () => {
				const b = (await infra().state()).otlp.filter((x) => x.via === 'exe-token');
				return b.some((x) => x.service === OPS_SERVICE || x.service === 'granary') ? b : null;
			},
			{ timeout: 30_000, message: 'OTLP batches via the token front' }
		);
		expect(batches.map((b) => b.signal)).toContain('traces');
		const stats = await ops().sinkStats(SINK);
		expect(stats.sentBatches).toBeGreaterThan(0);
		expect(stats.lastError).toBeNull();
	}, 45_000);

	test('proxy down → buffering and drops are counted, the condition escalates, and it recovers', async () => {
		await infra().fault({ target: 'exe-proxy', method: '*', pathPattern: '.', status: 503, count: 1_000_000 });
		const cond = await h().waitFor(
			async () => {
				const c = await ops().condition(COND);
				return c && (c.state === 'healing' || c.state === 'attention') ? c : null;
			},
			{ timeout: 45_000, message: `${COND} to escalate` }
		);
		expect(['healing', 'attention']).toContain(cond.state);
		// Batches in flight aren't counted as buffered, so wait for the counters to show it.
		const during = await h().waitFor(
			async () => {
				const st = await ops().sinkStats(SINK);
				return st.lastError !== null && st.bufferedBytes + st.droppedBytes > 0 ? st : null;
			},
			{ timeout: 15_000, message: 'sink stats to show the failure and buffered/dropped bytes' }
		);
		expect(during.lastError).not.toBeNull();

		await infra().clearFaults();
		await h().waitFor(async () => (await ops().condition(COND))?.state === 'ok', { timeout: 45_000, message: `${COND} back to ok` });
		const after = await ops().sinkStats(SINK);
		expect(after.sentBatches).toBeGreaterThan(during.sentBatches);
	}, 120_000);
});
