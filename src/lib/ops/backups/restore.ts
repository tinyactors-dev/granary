/**
 * Download → decrypt → verify, shared by restore drills and `ops:restore`
 * (ADR 0082, 0097, 0111). Only committed backups (manifest present) are
 * trusted; unencrypted artifacts are refused.
 */
import { parseJson } from '../../schemas/standard';
import { BackupManifest } from '../schemas/manifest';
import type { DrillResult } from '../schemas/runs';
import type { MasterKeys } from '../../platform/secrets/keys';
import { parseListing, type ListedBackup } from './retention-plan';
import { IntegrityError, assertEncrypted, unsealToFile } from './seal';
import type { BackupStore } from './stores';
import { StoreFailure } from './stores';

export async function listBackups(store: BackupStore, database?: string): Promise<ListedBackup[]> {
	const { backups } = parseListing(await store.list(store.prefix), store.prefix);
	return backups.filter((b) => !database || b.database === database).sort((a, b) => b.createdAt - a.createdAt);
}

export class RestoreFailure extends Error {
	constructor(
		readonly result: DrillResult,
		message: string
	) {
		super(message);
		this.name = 'RestoreFailure';
	}
}

/** Read and validate a manifest (refusing unencrypted ones). */
export async function readManifest(store: BackupStore, manifestKey: string): Promise<BackupManifest> {
	let text: string | null;
	try {
		text = await store.getText(manifestKey);
	} catch (e) {
		throw new RestoreFailure('download-failed', (e as Error).message);
	}
	if (text === null) throw new RestoreFailure('no-backup', `manifest ${manifestKey} not found`);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new RestoreFailure('checksum-mismatch', `manifest ${manifestKey} is not JSON`);
	}
	try {
		assertEncrypted(raw as Partial<BackupManifest>);
	} catch (e) {
		throw new RestoreFailure('not-encrypted', (e as Error).message);
	}
	try {
		return parseJson(BackupManifest, text, `manifest ${manifestKey}`);
	} catch (e) {
		throw new RestoreFailure('checksum-mismatch', `manifest ${manifestKey} is invalid: ${(e as Error).message}`);
	}
}

/** Download + unseal + verify hashes into `outPath`. Throws RestoreFailure. */
export async function fetchBackup(opts: { store: BackupStore; manifest: BackupManifest; keys: MasterKeys; outPath: string }): Promise<{ bytes: number }> {
	let source: ReadableStream<Uint8Array>;
	try {
		source = await opts.store.getStream(opts.manifest.artifactKey);
	} catch (e) {
		throw new RestoreFailure(e instanceof StoreFailure && e.error.status === 404 ? 'no-backup' : 'download-failed', (e as Error).message);
	}
	try {
		return await unsealToFile({ source, manifest: opts.manifest, keys: opts.keys, outPath: opts.outPath });
	} catch (e) {
		if (e instanceof IntegrityError) {
			const m = e.message;
			throw new RestoreFailure(/not encrypted/.test(m) ? 'not-encrypted' : /decrypt|KEK/.test(m) ? 'decrypt-failed' : 'checksum-mismatch', m);
		}
		if (e instanceof StoreFailure) throw new RestoreFailure('download-failed', e.message);
		throw new RestoreFailure('download-failed', String((e as Error)?.message ?? e));
	}
}
