/**
 * `remediate` I/O processor (ADR 0101, 0123): performs one self-healing
 * action for `remediator/main` and replies `remediated` / `remediation.failed`.
 *
 * Built in (health feature): `spool-cleanup`, `wal-checkpoint-truncate`,
 * `reset-sink-circuit`, `lower-sampling`. Other actions come from features
 * (`OpsFeature.remediations`, e.g. backups); an action nobody provides is a
 * `noop` with an explanation, never an error.
 */
import { Database } from 'bun:sqlite';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IOProcessor } from '@tinyactors/node';
import type { OpsContext, RemediationHandler } from '../feature';
import type { RemediationAction } from '../schemas/conditions';
import { sinkAddress, type OpsEventData } from '../schemas/events';
import type { Journal } from '../health/journal';
import { parseConditionName } from '../health/journal';

export const REMEDIATION_TIMEOUT_MS = 120_000;
/** Spool files younger than this may belong to a snapshot in progress. */
export const SPOOL_GRACE_MS = 10 * 60_000;

const GiB = 1024 ** 3;
const fmt = (n: number) => (n >= GiB ? `${(n / GiB).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`);

export function builtinRemediations(deps: { setSampleRatio: (f: (r: number) => number) => number }): Partial<Record<RemediationAction, RemediationHandler>> {
	return {
		async 'spool-cleanup'(ctx) {
			const dir = join(ctx.host.dataDir, 'ops-spool');
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				return { outcome: 'noop', detail: 'no spool directory' };
			}
			const referenced = new Set<string>();
			try {
				for (const r of ctx.db
					.query("SELECT raw_path FROM backup_runs WHERE raw_path IS NOT NULL AND state NOT IN ('succeeded','partial','failed','postponed')")
					.all() as { raw_path: string }[])
					referenced.add(r.raw_path);
			} catch {
				/* backups tables unused */
			}
			let freed = 0;
			let removed = 0;
			const now = ctx.now();
			for (const name of names) {
				const p = join(dir, name);
				try {
					const st = statSync(p);
					if (referenced.has(p) || [...referenced].some((r) => p.startsWith(r)) || now - st.mtimeMs < SPOOL_GRACE_MS) continue;
					rmSync(p, { recursive: true, force: true });
					freed += st.size;
					removed++;
				} catch {
					/* raced with the snapshot worker: next sample re-evaluates */
				}
			}
			return removed ? { outcome: 'done', detail: `removed ${removed} leftover spool file(s), freed ${fmt(freed)}` } : { outcome: 'noop', detail: 'no leftover spool files' };
		},

		async 'wal-checkpoint-truncate'(ctx) {
			const results: string[] = [];
			for (const d of ctx.host.databases) {
				let conn: Database | null = null;
				try {
					const before = walSize(d.path);
					conn = new Database(d.path);
					conn.exec('PRAGMA busy_timeout=5000');
					const r = conn.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number };
					results.push(`${d.id}: ${r.busy ? 'busy' : `WAL ${fmt(before)} → ${fmt(walSize(d.path))}`}`);
				} catch (e) {
					results.push(`${d.id}: ${e instanceof Error ? e.message : String(e)}`);
				} finally {
					conn?.close();
				}
			}
			try {
				ctx.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
				results.push('ops: checkpointed');
			} catch {
				/* ignore */
			}
			return { outcome: 'done', detail: results.join('; ') };
		},

		async 'reset-sink-circuit'(ctx, req) {
			if (!req.subject) return { outcome: 'noop', detail: 'no sink named' };
			ctx.post(sinkAddress(req.subject), 'sink.probe', {});
			return { outcome: 'done', detail: `probing sink ${req.subject} now` };
		},

		async 'lower-sampling'() {
			const to = deps.setSampleRatio((r) => r / 2);
			return { outcome: 'done', detail: `trace sample ratio lowered to ${to.toFixed(2)}` };
		}
	};
}

function walSize(path: string): number {
	try {
		return statSync(`${path}-wal`).size;
	} catch {
		return 0;
	}
}

export function remediateProcessor(deps: {
	ctx: () => OpsContext;
	handlers: () => Partial<Record<RemediationAction, RemediationHandler>>;
	journal: Journal;
	onEvent: (e: { at: number; kind: 'handled' | 'info'; conditionId: string; message: string }) => void;
}): IOProcessor {
	return {
		async send(request, effect) {
			const r = request.data as OpsEventData<'remediate'>;
			const reply = (event: string, data: unknown) => {
				try {
					effect.post(request.source, event, data);
				} catch {
					/* remediator gone (shutdown) */
				}
			};
			const handler = deps.handlers()[r.action];
			const ctx = deps.ctx();
			const subject = parseConditionName(r.conditionId)?.subject ?? null;
			if (!handler) {
				reply('remediated', { conditionId: r.conditionId, action: r.action, outcome: 'noop', detail: `no feature provides ${r.action} yet` });
				return;
			}
			try {
				const result = await Promise.race([
					handler(ctx, { ...r, subject }),
					new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${REMEDIATION_TIMEOUT_MS} ms`)), REMEDIATION_TIMEOUT_MS).unref?.())
				]);
				const at = ctx.now();
				const message = `${r.action} for ${r.conditionId}: ${result.detail}`;
				const kind = result.outcome === 'done' ? 'handled' : 'info';
				deps.journal.appendEvent({ at, kind, conditionId: r.conditionId, message, evidence: { action: r.action, attempt: r.attempt } });
				deps.onEvent({ at, kind, conditionId: r.conditionId, message });
				reply('remediated', { conditionId: r.conditionId, action: r.action, outcome: result.outcome, detail: ctx.redactor.redact(result.detail) });
			} catch (e) {
				const error = ctx.redactor.redact(e instanceof Error ? e.message : String(e));
				deps.journal.appendEvent({ at: ctx.now(), kind: 'info', conditionId: r.conditionId, message: `${r.action} for ${r.conditionId} failed: ${error}` });
				reply('remediation.failed', { conditionId: r.conditionId, action: r.action, error });
			}
		}
	};
}
