/**
 * `backup-ledger` I/O processor (ADR 0111): the backups feature's writes to
 * ops.sqlite and its effects on the ops System (spawning run/upload mail,
 * reconciling long-lived actors). Charts stay pure; every persisted
 * transition is an explicit, traced request. Write-before-effect: rows are
 * committed before the mail that depends on them is posted.
 *
 *   config.reconcile       → spawn/replace/destroy plan, retention, drill actors → config.reconciled
 *   plan.dispatch          → insert backup_runs (one per database) → plan.dispatched; run.start → backup-run/<id>
 *   plan.refresh-interval  → egress-aware effective interval → plan.interval
 *   run.uploads            → run state uploading; insert uploads rows; upload.start → upload/<run>.<dest>
 *                            (already terminal uploads answer the run directly)
 *   run.finalize           → terminal run state; drop the raw snapshot; run.finished → backup-plan/<id>
 *   upload.record-retry    → uploads: retry-wait, next_attempt_at, last_error
 *   upload.record-failed   → uploads: failed, last_error
 */
import type { EffectContext, IOProcessor, IORequest } from '@tinyactors/node';
import { rm } from 'node:fs/promises';
import { artifactKey } from '../schemas/destinations';
import { parseOpsEventData, planAddress, runAddress, uploadAddress } from '../schemas/events';
import type { BackupsRuntime } from '../backups/runtime';
import { newId } from '../backups/repo';

export function backupLedgerProcessor(rt: BackupsRuntime): IOProcessor {
	return {
		send(request: IORequest, context: EffectContext) {
			const reply = (event: string, data: unknown) => context.post(request.source, event, data);
			const post = (target: { family: string; name: string }, event: string, data: unknown) => context.post(target, event, data);
			const r = rt.r;
			switch (request.event) {
				case 'config.reconcile': {
					const d = parseOpsEventData('config.reconcile', request.data);
					return reply('config.reconciled', rt.reconcile(d.area, d.id));
				}
				case 'plan.dispatch': {
					const d = parseOpsEventData('plan.dispatch', request.data);
					const startedAt = rt.now;
					const refuse = (why: string) => {
						r.event('info', `backup plan ${d.planId}: run not started — ${why}`, { planId: d.planId, trigger: d.trigger });
						reply('plan.dispatched', { planId: d.planId, runIds: [], startedAt, refused: why });
					};
					if (!rt.keys?.current) return refuse('GRANARY_MASTER_KEY is not configured (backups are always encrypted, ADR 0097)');
					const plan = r.plan(d.planId);
					if (!plan) return refuse('plan no longer exists');
					const destinationIds = plan.destinationIds.filter((id) => r.destination(id)?.enabled);
					if (!destinationIds.length) return refuse('no enabled destination');
					const dbs = plan.databases.filter((id) => rt.database(id));
					if (!dbs.length) return refuse(`none of the plan's databases exist (${plan.databases.join(', ')})`);
					const runs = dbs.map((database) => ({ id: newId('run', startedAt), planId: plan.id, database, trigger: d.trigger, startedAt }));
					r.tx(() => {
						for (const run of runs) r.insertRun(run);
						r.audit(d.requestedBy ?? 'system', 'backup.dispatch', 'plan', plan.id, { trigger: d.trigger, runIds: runs.map((x) => x.id) });
					});
					reply('plan.dispatched', { planId: plan.id, runIds: runs.map((x) => x.id), startedAt, refused: null });
					for (const run of runs) {
						post(runAddress(run.id), 'run.start', { runId: run.id, planId: plan.id, database: run.database, destinationIds, trigger: d.trigger });
					}
					return;
				}
				case 'plan.refresh-interval': {
					const d = parseOpsEventData('plan.refresh-interval', request.data);
					const res = rt.refreshInterval(d.planId);
					return res ? reply('plan.interval', res) : undefined;
				}
				case 'run.uploads': {
					const d = parseOpsEventData('run.uploads', request.data);
					const run = r.runRow(d.runId);
					if (!run) return;
					r.tx(() => {
						r.setRunState(d.runId, 'uploading');
						for (const dest of d.destinationIds) r.insertUpload(d.runId, dest);
					});
					for (const dest of d.destinationIds) {
						const u = r.uploadRow(d.runId, dest)!;
						const m = r.uploadManifest(u);
						if (u.state === 'done') reply('upload.done', { runId: d.runId, destinationId: dest, manifestKey: `${u.artifact_key}.manifest.json`, sealedBytes: m?.sealed.bytes ?? u.uploaded_bytes });
						else if (u.state === 'failed') reply('upload.failed', { runId: d.runId, destinationId: dest, attempts: u.attempts, lastError: r.uploadSummary(u).lastError ?? { code: 'other', retryable: false, status: null, providerCode: null, message: 'failed', retryAfterMs: null } });
						else {
							const destination = r.destination(dest);
							const key = u.artifact_key ?? artifactKey(destination && destination.settings.kind !== 'local-dir' ? destination.settings.prefix : '', d.snapshot.database, d.runId, run.started_at);
							post(uploadAddress(d.runId, dest), 'upload.start', { runId: d.runId, destinationId: dest, snapshot: d.snapshot, artifactKey: key });
						}
					}
					return;
				}
				case 'run.finalize': {
					const d = parseOpsEventData('run.finalize', request.data);
					const run = r.runRow(d.runId);
					r.finalizeRun(d.runId, d.state, d.sealedBytes, d.error);
					if (run?.raw_path) void rm(run.raw_path, { force: true });
					if (d.state !== 'succeeded') r.event(d.state === 'postponed' ? 'handled' : 'info', `backup run ${d.runId} (${run?.database ?? '?'}) ${d.state}${d.error ? `: ${d.error}` : ''}`, { runId: d.runId, planId: d.planId, state: d.state });
					post(planAddress(d.planId), 'run.finished', { runId: d.runId, state: d.state, sealedBytes: d.sealedBytes });
					return;
				}
				case 'upload.record-retry': {
					const d = parseOpsEventData('upload.record-retry', request.data);
					return r.setUploadState(d.runId, d.destinationId, 'retry-wait', { attempts: d.attempts, nextAttemptAt: d.nextAttemptAt, lastError: d.lastError });
				}
				case 'upload.record-failed': {
					const d = parseOpsEventData('upload.record-failed', request.data);
					return r.setUploadState(d.runId, d.destinationId, 'failed', { attempts: d.attempts, lastError: d.lastError });
				}
				default:
					throw new Error(`backup-ledger processor: unknown request ${request.event}`);
			}
		}
	};
}
