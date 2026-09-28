/**
 * The setup checklist (ADR 0240) reflects the real state: the backup step is
 * done only once an off-site backup is verified AND a restore drill passed,
 * in `granary doctor --json` (via the admin socket; /settings renders the
 * same getSetupStatus result).
 * Regression: the step was hard-coded as "not done" on /settings.
 */
import { describe, expect, test } from 'bun:test';
import { runCli, useHarness } from './harness';
import { OpsClient } from './ops';
import type { SetupStatus, SetupStep } from '../src/lib/schemas/admins';

const h = useHarness({ infra: true });
const ops = () => new OpsClient(h());

async function setupSteps(): Promise<Map<SetupStep['id'], SetupStep>> {
	const r = await runCli(h(), ['doctor', '--json']);
	const setup = (JSON.parse(r.stdout) as { setup: SetupStatus | null }).setup;
	expect(setup).not.toBeNull();
	return new Map(setup!.steps.map((s) => [s.id, s]));
}

describe('setup checklist', () => {
	test('off-site backups turn done after a verified backup and a passing restore drill', async () => {
		// The boot backup reaches the fake R2 (seed-r2), but no drill has run yet.
		const before = await h().waitFor(
			async () => {
				const s = await ops().status();
				const r2 = s.backups.find((b) => b.destinationId === 'seed-r2' && b.lastVerifiedAt !== null);
				return r2 ? await setupSteps() : null;
			},
			{ timeout: 30_000, message: 'a verified off-site backup on seed-r2' }
		);
		const backupsBefore = before.get('backups')!;
		expect(backupsBefore.status).not.toBe('done');
		expect(backupsBefore.detail.toLowerCase()).toContain('restore drill');
		expect(backupsBefore.optional).toBe(false);
		// The other required steps reflect the harness: an admin, the app connected on the fake GitHub.
		expect(before.get('admins')!.status).toBe('done');
		expect(before.get('github')!.status).toBe('done');

		await ops().drillNow('seed-r2');
		await h().waitFor(
			async () => {
				const d = (await ops().drills()).filter((x) => x.destinationId === 'seed-r2' && x.finishedAt !== null);
				return d.length > 0 && d.every((x) => x.result === 'ok') ? d : null;
			},
			{ timeout: 30_000, message: 'a passing drill on seed-r2' }
		);

		const after = await h().waitFor(
			async () => {
				const steps = await setupSteps();
				return steps.get('backups')!.status === 'done' ? steps : null;
			},
			{ timeout: 15_000, message: 'the backups setup step to be done' }
		);
		expect(after.get('backups')!.detail).toContain('restore drill passed');
		// /settings renders these steps as returned by getSetupStatus (client-side, inside a
		// svelte:boundary), the same backend method the admin socket's doctor calls.
	}, 120_000);
});
