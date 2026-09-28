/**
 * Self-healing actions the backups feature contributes to `remediator/main`
 * (ADR 0101, 0115). Each is idempotent and derived from current facts; none
 * pages anyone. `subject` is the condition's subject (plan or destination id).
 */
import type { RemediationHandler } from '../feature';
import type { RemediationAction } from '../schemas/conditions';
import { MAX_STRETCHED_INTERVAL_MS } from '../schemas/plans';
import { REMEDIATION_STRETCH_HOLD_MS } from './runtime';
import { OPS_CONFIG_ADDRESS, drillAddress, planAddress, uploadAddress } from '../schemas/events';
import type { BackupsRuntime } from './runtime';
import { openStore } from './stores';

export function backupsRemediations(rt: BackupsRuntime): Partial<Record<RemediationAction, RemediationHandler>> {
	return {
		/** Delete the on-box copies (they are for fast restores, not safety; ADR 0098). */
		'drop-local-copy': async () => {
			let deleted = 0;
			for (const d of rt.r.destinations().filter((x) => x.settings.kind === 'local-dir')) {
				const store = await openStore(d.settings, { secret: async () => '', dataDir: rt.c.host.dataDir });
				for (const o of await store.list('')) {
					await store.delete(o.key);
					deleted++;
				}
			}
			if (deleted) rt.r.event('handled', `dropped the local backup copy (${deleted} files) to free disk space`, { deleted });
			return deleted ? { outcome: 'done', detail: `deleted ${deleted} local backup file(s)` } : { outcome: 'noop', detail: 'no local copy on disk' };
		},

		/** Runs refuse to start while the disk rule fails (snapshot.failed → postponed); nothing else to do. */
		'postpone-backup': async () => {
			const postponed = (rt.r.db.query("SELECT count(*) AS n FROM backup_runs WHERE state = 'postponed' AND started_at > ?").get(rt.now - 86_400_000) as { n: number }).n;
			return { outcome: 'noop', detail: `backups postpone themselves while the disk reserve is not met (${postponed} postponed in the last 24 h)` };
		},

		/** Double the plan's effective interval (max 6 h) — fewer uploads, less pressure. */
		'stretch-interval': async (_ctx, req) => {
			const plans = req.subject ? [rt.r.plan(req.subject)].filter((p) => !!p) : rt.r.plans();
			const changed: string[] = [];
			for (const p of plans) {
				const cur = p!.effectiveIntervalMs || p!.intervalMs;
				const next = Math.min(Math.max(MAX_STRETCHED_INTERVAL_MS, p!.intervalMs), cur * 2);
				if (next > cur) {
					rt.r.setEffectiveInterval(p!.id, next);
					// Keep the stretch for a day so the next egress refresh can't undo it (ADR 0150).
					rt.r.kvSet(`stretch:${p!.id}`, JSON.stringify({ ms: next, until: rt.now + REMEDIATION_STRETCH_HOLD_MS }));
					rt.post(OPS_CONFIG_ADDRESS, 'config.changed', { area: 'plan', id: p!.id });
					changed.push(`${p!.id}: ${Math.round(cur / 60_000)} → ${Math.round(next / 60_000)} min`);
				}
			}
			return changed.length ? { outcome: 'done', detail: `interval stretched (${changed.join('; ')})` } : { outcome: 'noop', detail: 'interval already at its maximum' };
		},

		/** Cut short uploads waiting to retry; start a fresh run if the latest one failed. */
		'retry-upload': async (_ctx, req) => {
			const waiting = rt.r.db
				.query(`SELECT u.run_id, u.destination_id FROM uploads u JOIN backup_runs r ON r.id = u.run_id WHERE u.state = 'retry-wait' ${req.subject ? 'AND r.plan_id = ?' : ''}`)
				.all(...(req.subject ? [req.subject] : [])) as { run_id: string; destination_id: string }[];
			for (const w of waiting) rt.post(uploadAddress(w.run_id, w.destination_id), 'upload.retry', {});
			if (waiting.length) return { outcome: 'done', detail: `retrying ${waiting.length} waiting upload(s) now` };
			if (req.subject && rt.r.plan(req.subject)) {
				rt.post(planAddress(req.subject), 'plan.run-now', { requestedBy: 'remediator' });
				return { outcome: 'done', detail: `started a new backup run of plan ${req.subject}` };
			}
			return { outcome: 'noop', detail: 'no upload is waiting to retry' };
		},

		'rerun-drill': async (_ctx, req) => {
			const ids = req.subject ? [req.subject] : rt.r.destinations().filter((d) => d.enabled).map((d) => d.id);
			for (const id of ids) rt.post(drillAddress(id), 'drill.run-now', { requestedBy: 'remediator' });
			return ids.length ? { outcome: 'done', detail: `restore drill re-run for ${ids.join(', ')}` } : { outcome: 'noop', detail: 'no destination to drill' };
		}
	};
}
