/**
 * `snapshot` I/O processor (ADR 0083, 0098, 0111).
 *
 *   snapshot.request {runId, database, dbPath, spoolDir}
 *     → backup_runs: state=snapshotting, attempt+1 (write-before-effect)
 *     → remove this run's leftovers from the spool
 *     → disk rule: free − dbSize ≥ max(minFreeBytes, minFreeRatio × total)
 *     → Worker: VACUUM INTO + integrity_check + facts + sha256
 *     → backup_runs: raw_path/raw_bytes/raw_sha256/snapshot
 *     → reply snapshot.ready | snapshot.failed
 *   drill.check {drillId, destinationId, runId, localPath, manifest}
 *     → Worker: integrity_check + row counts of the restored copy
 *     → compare with the manifest → restore_drills row → reply drill.checked
 */
import type { EffectContext, IOProcessor, IORequest } from '@tinyactors/node';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOpsEventData } from '../schemas/events';
import type { DrillResult } from '../schemas/runs';
import type { BackupsRuntime } from '../backups/runtime';
import { diskFacts, snapshotAllowed } from '../backups/disk';

export function snapshotProcessor(rt: BackupsRuntime): IOProcessor {
	return {
		send(request: IORequest, context: EffectContext) {
			const reply = (event: string, data: unknown) => context.post(request.source, event, data);
			if (request.event === 'snapshot.request') void takeSnapshot(rt, request, reply);
			else if (request.event === 'drill.check') void checkDrill(rt, request, reply);
			else throw new Error(`snapshot processor: unknown request ${request.event}`);
		}
	};
}

async function takeSnapshot(rt: BackupsRuntime, request: IORequest, reply: (e: string, d: unknown) => void) {
	const d = parseOpsEventData('snapshot.request', request.data);
	const fail = (reason: 'disk-insufficient' | 'integrity' | 'sqlite-error' | 'worker-crashed', detail: string) => reply('snapshot.failed', { runId: d.runId, reason, detail });
	try {
		rt.r.setRunState(d.runId, 'snapshotting', { attemptInc: true });
		await mkdir(d.spoolDir, { recursive: true });
		await removeRunFiles(d.spoolDir, d.runId);
		const disk = await diskFacts(d.spoolDir, rt.c.host.env);
		const allowed = snapshotAllowed(disk, rt.dbBytes(d.dbPath), rt.r.budgets());
		if (!allowed.ok) return fail('disk-insufficient', `not enough free disk for a snapshot: ${allowed.detail}`);
		const outPath = join(d.spoolDir, `${d.runId}.${d.database}.sqlite`);
		const res = await rt.worker.snapshot(d.dbPath, outPath);
		if (!res.ok) return fail(res.reason, res.detail);
		const f = res.facts;
		const snapshot = {
			runId: d.runId,
			database: d.database,
			rawPath: outPath,
			rawBytes: f.rawBytes,
			rawSha256: f.rawSha256!,
			sqliteVersion: f.sqliteVersion,
			userVersion: f.userVersion,
			pageCount: f.pageCount,
			rowCounts: f.rowCounts
		};
		rt.r.setRunSnapshot(d.runId, snapshot);
		reply('snapshot.ready', snapshot);
	} catch (e) {
		fail('sqlite-error', String((e as Error)?.message ?? e));
	}
}

/** Delete `<runId>.*` files (partial or complete) of one run from the spool. */
export async function removeRunFiles(spoolDir: string, runId: string): Promise<number> {
	let n = 0;
	let entries: string[] = [];
	try {
		entries = await readdir(spoolDir);
	} catch {
		return 0;
	}
	for (const name of entries) {
		if (name.startsWith(`${runId}.`)) {
			await rm(join(spoolDir, name), { force: true });
			n++;
		}
	}
	return n;
}

async function checkDrill(rt: BackupsRuntime, request: IORequest, reply: (e: string, d: unknown) => void) {
	const d = parseOpsEventData('drill.check', request.data);
	let result: DrillResult = 'ok';
	let detail: string | null = null;
	try {
		const res = await rt.worker.check(d.localPath);
		if (!res.ok) {
			result = 'integrity-failed';
			detail = res.detail;
		} else {
			const want = d.manifest.rowCounts;
			const got = res.facts.rowCounts;
			const diffs = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter((t) => want[t] !== got[t]).map((t) => `${t}: ${got[t] ?? '∅'} ≠ ${want[t] ?? '∅'}`);
			if (diffs.length) {
				result = 'row-count-mismatch';
				detail = diffs.slice(0, 10).join('; ');
			} else {
				detail = `integrity ok; ${Object.keys(got).length} tables, ${Object.values(got).reduce((a, b) => a + b, 0)} rows match the manifest`;
			}
		}
	} catch (e) {
		result = 'integrity-failed';
		detail = String((e as Error)?.message ?? e);
	} finally {
		await rm(d.localPath, { force: true });
	}
	rt.r.finishDrill(d.drillId, result, detail, rt.now - d.manifest.createdAt);
	reply('drill.checked', { drillId: d.drillId, result, detail });
}
