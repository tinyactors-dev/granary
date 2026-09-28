/**
 * `object-store` I/O processor (ADR 0082, 0084, 0095, 0096, 0098, 0111).
 * The only code that talks to destinations. Every reply goes to
 * `request.source`; failures are classified `store.error {code, retryable}`.
 *
 *   store.put-artifact  seal (zstd → AES-256-GCM) straight into a multipart
 *                       upload; record manifest in `uploads` (state
 *                       committing) → store.artifact-stored
 *   store.put-manifest  create-once commit marker (If-None-Match: *)
 *                       → store.manifest-committed
 *   store.verify        HEAD artifact (size = manifest.sealed.bytes) and
 *                       manifest → uploads state done → store.verified
 *   retention.pass      list → plan → delete (manifest, then data) → re-list,
 *                       until converged (≤ 5) → retention.pass-done
 *   drill.fetch         newest committed backup of a database → download,
 *                       decrypt, verify hashes → drill.fetched | drill.checked
 */
import type { EffectContext, IOProcessor, IORequest } from '@tinyactors/node';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOpsEventData } from '../schemas/events';
import { manifestKeyOf, type Destination } from '../schemas/destinations';
import type { BackupManifest } from '../schemas/manifest';
import type { StoreError } from '../schemas/runs';
import type { BackupsRuntime } from '../backups/runtime';
import { MANIFEST_FORMAT, sealFile, ZSTD_LEVEL, IntegrityError } from '../backups/seal';
import { StoreFailure, storeError, toStoreFailure } from '../backups/stores';
import { MAX_CONVERGENCE_ITERATIONS, planRetention } from '../backups/retention-plan';
import { diskFacts, localCopyAllowed } from '../backups/disk';
import { RestoreFailure, fetchBackup, listBackups, readManifest } from '../backups/restore';

const CONTENT_ARTIFACT = 'application/octet-stream';
const CONTENT_MANIFEST = 'application/json';

export function objectStoreProcessor(rt: BackupsRuntime): IOProcessor {
	return {
		send(request: IORequest, context: EffectContext) {
			const reply = (event: string, data: unknown) => context.post(request.source, event, data);
			switch (request.event) {
				case 'store.put-artifact':
					return void putArtifact(rt, request, reply);
				case 'store.put-manifest':
					return void putManifest(rt, request, reply);
				case 'store.verify':
					return void verify(rt, request, reply);
				case 'retention.pass':
					return void retentionPass(rt, request, reply);
				case 'drill.fetch':
					return void drillFetch(rt, request, reply);
				default:
					throw new Error(`object-store processor: unknown request ${request.event}`);
			}
		}
	};
}

function asStoreError(e: unknown, op: string): StoreError {
	if (e instanceof StoreFailure) return e.error;
	if (e instanceof IntegrityError) return storeError('integrity', `${op}: ${e.message}`);
	return toStoreFailure(e, op).error;
}

async function putArtifact(rt: BackupsRuntime, request: IORequest, reply: (e: string, d: unknown) => void) {
	const d = parseOpsEventData('store.put-artifact', request.data);
	let dest: Destination | null = null;
	let sent = 0;
	try {
		rt.r.setUploadState(d.runId, d.destinationId, 'uploading', { attemptInc: true, artifactKey: d.artifactKey, nextAttemptAt: null });
		dest = rt.r.requireDestination(d.destinationId);
		const kek = rt.keys?.current;
		if (!kek) throw new StoreFailure(storeError('other', 'GRANARY_MASTER_KEY is not configured: backups cannot be sealed (ADR 0097)', { retryable: false }));
		if (dest.settings.kind === 'local-dir') {
			const facts = await diskFacts(rt.c.host.dataDir, rt.c.host.env);
			const ok = localCopyAllowed(facts, d.snapshot.rawBytes, rt.r.budgets());
			if (!ok.ok) throw new StoreFailure(storeError('quota', `local copy skipped to protect the disk: ${ok.detail}`, { retryable: false }));
		}
		const store = await rt.store(dest, `object-store:put-artifact:${d.runId}`);
		const seal = sealFile({ rawPath: d.snapshot.rawPath, runId: d.runId, kek, expectedRawSha256: d.snapshot.rawSha256 });
		await store.putStream(d.artifactKey, seal.stream, CONTENT_ARTIFACT, (n) => (sent += n));
		const r = seal.result();
		const manifest: BackupManifest = {
			format: MANIFEST_FORMAT,
			runId: d.runId,
			database: d.snapshot.database,
			createdAt: rt.now,
			granaryVersion: rt.c.host.version,
			sqliteVersion: d.snapshot.sqliteVersion,
			userVersion: d.snapshot.userVersion,
			pageCount: d.snapshot.pageCount,
			rowCounts: d.snapshot.rowCounts,
			raw: r.raw,
			compressed: { alg: 'zstd', level: seal.level ?? ZSTD_LEVEL, bytes: r.compressed.bytes, sha256: r.compressed.sha256 },
			sealed: r.sealed,
			encryption: r.encryption,
			artifactKey: d.artifactKey
		};
		rt.r.recordArtifact(d.runId, d.destinationId, manifest, r.sealed.bytes);
		if (rt.secretRefOf(dest)) rt.secrets!.recordUse(rt.secretRefOf(dest)!, true);
		reply('store.artifact-stored', { runId: d.runId, destinationId: d.destinationId, manifest });
	} catch (e) {
		const error = asStoreError(e, `upload ${d.artifactKey}`);
		if (dest && rt.secretRefOf(dest) && error.code === 'auth') rt.secrets!.recordUse(rt.secretRefOf(dest)!, false);
		reply('store.error', { op: 'put-artifact', runId: d.runId, destinationId: d.destinationId, error });
	} finally {
		// Bytes that left the VM are billed even when the upload failed (ADR 0107).
		const kind = dest ? rt.egressKind(dest) : null;
		if (kind && sent) rt.r.addEgress(kind, sent);
	}
}

async function putManifest(rt: BackupsRuntime, request: IORequest, reply: (e: string, d: unknown) => void) {
	const d = parseOpsEventData('store.put-manifest', request.data);
	const key = manifestKeyOf(d.manifest.artifactKey);
	let dest: Destination | null = null;
	try {
		dest = rt.r.requireDestination(d.destinationId);
		const store = await rt.store(dest, `object-store:put-manifest:${d.runId}`);
		const body = JSON.stringify(d.manifest, null, 2);
		const outcome = await store.putIfAbsent(key, body, CONTENT_MANIFEST);
		if (outcome === 'exists') {
			// Already committed (a crash after the PUT): it must be ours (same sealed hash).
			const existing = await store.getText(key);
			const same = existing !== null && (JSON.parse(existing) as BackupManifest).sealed?.sha256 === d.manifest.sealed.sha256;
			if (!same) throw new StoreFailure(storeError('conflict', `a different manifest is already committed at ${key}`, { retryable: false, status: 412 }));
		}
		const kind = rt.egressKind(dest);
		if (kind && outcome === 'created') rt.r.addEgress(kind, body.length);
		rt.r.setUploadState(d.runId, d.destinationId, 'verifying');
		reply('store.manifest-committed', { runId: d.runId, destinationId: d.destinationId, manifestKey: key, alreadyExisted: outcome === 'exists' });
	} catch (e) {
		reply('store.error', { op: 'put-manifest', runId: d.runId, destinationId: d.destinationId, error: asStoreError(e, `commit ${key}`) });
	}
}

async function verify(rt: BackupsRuntime, request: IORequest, reply: (e: string, d: unknown) => void) {
	const d = parseOpsEventData('store.verify', request.data);
	const key = manifestKeyOf(d.manifest.artifactKey);
	try {
		const dest = rt.r.requireDestination(d.destinationId);
		const store = await rt.store(dest, `object-store:verify:${d.runId}`);
		const [art, man] = await Promise.all([store.head(d.manifest.artifactKey), store.head(key)]);
		if (!man) throw new StoreFailure(storeError('integrity', `manifest ${key} missing after commit`));
		if (!art || art.size !== d.manifest.sealed.bytes) {
			// The committed manifest points at a missing/incomplete artifact: un-commit it
			// (manifest first, ADR 0082) and start the upload over (ADR 0112).
			await store.delete(key);
			rt.r.clearManifest(d.runId, d.destinationId);
			throw new StoreFailure(storeError('integrity', `artifact ${d.manifest.artifactKey} is ${art ? `${art.size} bytes` : 'missing'} (manifest says ${d.manifest.sealed.bytes}); manifest withdrawn, re-uploading`));
		}
		rt.r.setUploadState(d.runId, d.destinationId, 'done', { lastError: null });
		rt.log.info(`backup: upload ${d.runId} → ${d.destinationId} done`, { 'backup.run_id': d.runId, 'backup.destination_id': d.destinationId, 'backup.sealed_bytes': d.manifest.sealed.bytes, 'backup.artifact_key': d.manifest.artifactKey });
		reply('store.verified', { runId: d.runId, destinationId: d.destinationId, manifestKey: key, sealedBytes: d.manifest.sealed.bytes });
	} catch (e) {
		reply('store.error', { op: 'verify', runId: d.runId, destinationId: d.destinationId, error: asStoreError(e, `verify ${key}`) });
	}
}

async function retentionPass(rt: BackupsRuntime, request: IORequest, reply: (e: string, d: unknown) => void) {
	const d = parseOpsEventData('retention.pass', request.data);
	let deleted = 0;
	let freedBytes = 0;
	let iterations = 0;
	let converged = false;
	let floorExceedsCap = false;
	let unknownObjects = 0;
	try {
		const dest = rt.r.requireDestination(d.destinationId);
		const store = await rt.store(dest, `object-store:retention:${d.destinationId}`);
		const local = dest.settings.kind === 'local-dir';
		// local-dir keeps exactly one copy (ADR 0098).
		const schedule = local ? { ...dest.retention, floor: 1 } : dest.retention;
		const caps = local ? { ...dest.caps, maxBackupsPerDatabase: 1 } : dest.caps;
		// "Don't prune when sick": the last 3 uploads all failed → caps only (ADR 0096).
		const recent = rt.r.db.query('SELECT state FROM uploads WHERE destination_id = ? AND state IN (\'done\',\'failed\') ORDER BY updated_at DESC LIMIT 3').all(d.destinationId) as { state: string }[];
		const sick = recent.length === 3 && recent.every((r) => r.state === 'failed');
		const incoming = d.mode === 'make-room' && d.database && !local ? { database: d.database, bytes: d.estimatedBytes } : null;
		for (iterations = 1; iterations <= MAX_CONVERGENCE_ITERATIONS; iterations++) {
			const objects = await store.list(store.prefix);
			const plan = planRetention({ objects, prefix: store.prefix, now: rt.now, schedule, caps, incoming, sick });
			floorExceedsCap = plan.floorExceedsCap;
			unknownObjects = plan.unknownObjects;
			if (!plan.delete.length) {
				converged = true;
				break;
			}
			for (const del of plan.delete) {
				await store.delete(del.key); // manifest first, then its data object (plan order)
				deleted++;
				freedBytes += objects.find((o) => o.key === del.key)?.size ?? 0;
			}
		}
		iterations = Math.min(iterations, MAX_CONVERGENCE_ITERATIONS);
		rt.r.kvSet(`retention:${d.destinationId}`, JSON.stringify({ at: rt.now, mode: d.mode, deleted, freedBytes, converged, floorExceedsCap, unknownObjects, sick }));
		if (deleted) rt.r.event('handled', `retention on ${dest.name}: deleted ${deleted} objects (${freedBytes} bytes)${sick ? ' — caps only, recent uploads failing' : ''}`, { destinationId: d.destinationId, mode: d.mode, deleted, freedBytes });
		(deleted ? rt.log.info : rt.log.debug ?? (() => {}))(`backup: retention pass on ${d.destinationId}: deleted ${deleted} object(s)`, { 'backup.destination_id': d.destinationId, 'retention.mode': d.mode, 'retention.deleted': deleted, 'retention.freed_bytes': freedBytes, 'retention.converged': converged, 'retention.sick': sick });
		reply('retention.pass-done', { destinationId: d.destinationId, deleted, freedBytes, converged, iterations, floorExceedsCap, unknownObjects });
	} catch (e) {
		rt.log.warn(`backup: retention pass on ${d.destinationId} failed`, { 'backup.destination_id': d.destinationId, 'retention.mode': d.mode, 'error.message': e instanceof Error ? e.message : String(e) });
		reply('retention.pass-done', { destinationId: d.destinationId, deleted, freedBytes, converged: false, iterations, floorExceedsCap, unknownObjects, error: asStoreError(e, `retention ${d.destinationId}`) });
	}
}

async function drillFetch(rt: BackupsRuntime, request: IORequest, reply: (e: string, d: unknown) => void) {
	const d = parseOpsEventData('drill.fetch', request.data);
	rt.r.insertDrill({ id: d.drillId, destinationId: d.destinationId, database: d.database });
	const checked = (result: string, detail: string) => {
		rt.r.finishDrill(d.drillId, result as never, detail, null);
		rt.log.warn(`backup: restore drill ${d.drillId} on ${d.destinationId}: ${result}`, { 'drill.id': d.drillId, 'backup.destination_id': d.destinationId, 'drill.result': String(result), 'drill.detail': detail ?? undefined });
		reply('drill.checked', { drillId: d.drillId, result, detail });
	};
	try {
		const dest = rt.r.requireDestination(d.destinationId);
		if (!rt.keys?.current && !rt.keys?.previous) return checked('decrypt-failed', 'GRANARY_MASTER_KEY is not configured');
		const store = await rt.store(dest, `object-store:drill:${d.destinationId}`);
		const latest = (await listBackups(store, d.database))[0];
		if (!latest) return checked('no-backup', `no committed backup of ${d.database} on ${dest.name}`);
		rt.r.setDrillRun(d.drillId, latest.runId);
		const manifest = await readManifest(store, latest.manifestKey);
		const dir = join(rt.spoolDir, 'drills');
		await mkdir(dir, { recursive: true });
		const localPath = join(dir, `${d.drillId}.sqlite`);
		const { bytes } = await fetchBackup({ store, manifest, keys: rt.keys!, outPath: localPath });
		reply('drill.fetched', { drillId: d.drillId, runId: latest.runId, localPath, bytes, manifest });
	} catch (e) {
		if (e instanceof RestoreFailure) return checked(e.result, e.message);
		checked('download-failed', String((e as Error)?.message ?? e));
	}
}
