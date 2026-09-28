/**
 * Streaming seal / unseal of backup artifacts (ADR 0097, 0098, 0113).
 *
 *   raw .sqlite ──(4 MiB blocks)──▶ zstd frames (concatenated = one valid
 *   zstd stream) ──▶ AES-256-GCM in `chunkBytes` chunks ──▶ upload sink
 *
 * Chunk i: nonce = nonceBase XOR i, AAD = `granary-ops-backup/1|<runId>|<i>|<last>`.
 * A final chunk (possibly empty) is always emitted with last=1, so truncation
 * and reordering fail authentication. Nothing sealed is written to local disk
 * (only the raw snapshot, ADR 0098). sha256 of raw, compressed and sealed
 * bytes are computed on the way and recorded in the manifest.
 */
import zlib from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import type { BackupManifest } from '../schemas/manifest';
import {
	IV_BYTES,
	KEY_BYTES,
	TAG_BYTES,
	aesGcmDecrypt,
	aesGcmEncrypt,
	b64,
	backupDekAad,
	chunkAad,
	chunkNonce,
	importAesKey,
	randomBytes,
	unb64,
	unwrapKey,
	wrapKey
} from '../../platform/secrets/crypto';
import type { Kek, MasterKeys } from '../../platform/secrets/keys';

export const SEAL_CHUNK_BYTES = 4 * 1024 * 1024;
export const RAW_BLOCK_BYTES = 4 * 1024 * 1024;
export const ZSTD_LEVEL = 9;
export const MANIFEST_FORMAT = 'granary-ops-backup/1' as const;

export class IntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'IntegrityError';
	}
}

export interface SealResult {
	compressed: { bytes: number; sha256: string };
	sealed: { bytes: number; sha256: string };
	raw: { bytes: number; sha256: string };
	encryption: BackupManifest['encryption'];
}

/** Read a file as fixed-size blocks (last one shorter). */
async function* fileBlocks(path: string, blockBytes: number): AsyncGenerator<Uint8Array> {
	const reader = Bun.file(path).stream().getReader();
	let buf = new Uint8Array(0);
	for (;;) {
		const { value, done } = await reader.read();
		if (value) {
			const merged = new Uint8Array(buf.length + value.length);
			merged.set(buf);
			merged.set(value, buf.length);
			buf = merged;
			while (buf.length >= blockBytes) {
				yield buf.slice(0, blockBytes);
				buf = buf.slice(blockBytes);
			}
		}
		if (done) break;
	}
	if (buf.length) yield buf;
}

/**
 * Seal `rawPath` for `runId`, yielding sealed bytes. `result()` is valid once
 * the generator is exhausted. The raw sha256 is re-computed and must equal
 * `expectedRawSha256` (the snapshot may not have changed since it was taken).
 */
export function sealFile(opts: { rawPath: string; runId: string; kek: Kek; expectedRawSha256: string; chunkBytes?: number; level?: number }) {
	const chunkBytes = opts.chunkBytes ?? SEAL_CHUNK_BYTES;
	const level = opts.level ?? ZSTD_LEVEL;
	const rawHash = new Bun.CryptoHasher('sha256');
	const compHash = new Bun.CryptoHasher('sha256');
	const sealedHash = new Bun.CryptoHasher('sha256');
	let rawBytes = 0;
	let compBytes = 0;
	let sealedBytes = 0;
	let result: SealResult | null = null;
	const dek = randomBytes(KEY_BYTES);
	const nonceBase = randomBytes(IV_BYTES);

	async function* generate(): AsyncGenerator<Uint8Array> {
		const key = await importAesKey(dek);
		let pending = new Uint8Array(0);
		let index = 0;
		const emit = async (plain: Uint8Array, last: boolean) => {
			const ct = await aesGcmEncrypt(key, chunkNonce(nonceBase, index), plain, chunkAad(opts.runId, index, last));
			index++;
			sealedHash.update(ct);
			sealedBytes += ct.length;
			return ct;
		};
		for await (const block of fileBlocks(opts.rawPath, RAW_BLOCK_BYTES)) {
			rawHash.update(block);
			rawBytes += block.length;
			const frame = new Uint8Array(await Bun.zstdCompress(block, { level }));
			compHash.update(frame);
			compBytes += frame.length;
			const merged = new Uint8Array(pending.length + frame.length);
			merged.set(pending);
			merged.set(frame, pending.length);
			pending = merged;
			while (pending.length > chunkBytes) {
				yield await emit(pending.slice(0, chunkBytes), false);
				pending = pending.slice(chunkBytes);
			}
		}
		// Final chunk (always present, may be empty) carries last=1.
		yield await emit(pending, true);
		const rawSha = rawHash.digest('hex');
		if (rawSha !== opts.expectedRawSha256) throw new IntegrityError(`raw snapshot changed since it was taken (sha256 ${rawSha} ≠ ${opts.expectedRawSha256})`);
		const wrapped = await wrapKey(opts.kek.key, dek, backupDekAad(opts.runId));
		dek.fill(0);
		result = {
			raw: { bytes: rawBytes, sha256: rawSha },
			compressed: { bytes: compBytes, sha256: compHash.digest('hex') },
			sealed: { bytes: sealedBytes, sha256: sealedHash.digest('hex') },
			encryption: { alg: 'AES-256-GCM', chunkBytes, kekId: opts.kek.id, wrappedDek: b64(wrapped), nonceBase: b64(nonceBase) }
		};
	}

	return {
		stream: generate(),
		result(): SealResult {
			if (!result) throw new Error('seal not finished');
			return result;
		},
		level
	};
}

/** Validate that a manifest carries a usable encryption block (ADR 0097: no plaintext path). */
export function assertEncrypted(m: Partial<BackupManifest> | null | undefined): asserts m is BackupManifest {
	const e = m?.encryption;
	if (!e || e.alg !== 'AES-256-GCM' || !e.wrappedDek || !e.nonceBase || !e.kekId || !(e.chunkBytes >= 65536)) {
		throw new IntegrityError('backup is not encrypted (no valid encryption block in its manifest); refusing to restore (ADR 0097)');
	}
}

export async function unwrapBackupDek(keys: MasterKeys, m: BackupManifest): Promise<CryptoKey> {
	const kek = keys.byId(m.encryption.kekId);
	if (!kek) throw new IntegrityError(`backup ${m.runId} is sealed with KEK ${m.encryption.kekId}, which is not configured (GRANARY_MASTER_KEY / _PREVIOUS)`);
	const dek = await unwrapKey(kek.key, unb64(m.encryption.wrappedDek), backupDekAad(m.runId));
	const key = await importAesKey(dek);
	dek.fill(0);
	return key;
}

/**
 * Unseal a sealed byte stream into `outPath` (written as `.partial`, renamed
 * on success). Verifies sealed, compressed and raw sha256 + sizes against the
 * manifest; any mismatch throws IntegrityError and removes the partial file.
 */
export async function unsealToFile(opts: { source: ReadableStream<Uint8Array>; manifest: BackupManifest; keys: MasterKeys; outPath: string }): Promise<{ bytes: number }> {
	const m = opts.manifest;
	assertEncrypted(m);
	const key = await unwrapBackupDek(opts.keys, m);
	const nonceBase = unb64(m.encryption.nonceBase);
	const frame = m.encryption.chunkBytes + TAG_BYTES;
	const sealedHash = new Bun.CryptoHasher('sha256');
	const compHash = new Bun.CryptoHasher('sha256');
	const rawHash = new Bun.CryptoHasher('sha256');
	let sealedBytes = 0;
	let compBytes = 0;
	let rawBytes = 0;
	const partial = `${opts.outPath}.partial`;
	const out = createWriteStream(partial, { mode: 0o600 }); // restored databases are as private as the originals
	const unzstd = zlib.createZstdDecompress();
	const done = new Promise<void>((resolve, reject) => {
		unzstd.on('data', (c: Buffer) => {
			rawHash.update(c);
			rawBytes += c.length;
			if (!out.write(c)) unzstd.pause();
		});
		out.on('drain', () => unzstd.resume());
		unzstd.on('end', () => out.end());
		unzstd.on('error', reject);
		out.on('error', reject);
		out.on('finish', () => resolve());
	});
	done.catch(() => {}); // observed below; avoid an unhandled rejection while still decrypting
	let index = 0;
	const decrypt = async (ct: Uint8Array, last: boolean) => {
		let pt: Uint8Array;
		try {
			pt = await aesGcmDecrypt(key, chunkNonce(nonceBase, index), ct, chunkAad(m.runId, index, last));
		} catch {
			throw new IntegrityError(`decryption failed at chunk ${index} (wrong key, corrupted or truncated artifact)`);
		}
		index++;
		compHash.update(pt);
		compBytes += pt.length;
		if (pt.length && !unzstd.write(pt)) await new Promise<void>((r) => unzstd.once('drain', () => r()));
	};
	try {
		const reader = opts.source.getReader();
		let buf = new Uint8Array(0);
		for (;;) {
			const { value, done: end } = await reader.read();
			if (value) {
				sealedHash.update(value);
				sealedBytes += value.length;
				const merged = new Uint8Array(buf.length + value.length);
				merged.set(buf);
				merged.set(value, buf.length);
				buf = merged;
				// Strictly greater: the remainder may be the (last) final frame.
				while (buf.length > frame) {
					await decrypt(buf.slice(0, frame), false);
					buf = buf.slice(frame);
				}
			}
			if (end) break;
		}
		if (buf.length < TAG_BYTES) throw new IntegrityError('artifact truncated (no final chunk)');
		await decrypt(buf, true);
		unzstd.end();
		await done;
		const check = (what: string, got: string, want: string) => {
			if (got !== want) throw new IntegrityError(`${what} sha256 mismatch: ${got} ≠ ${want}`);
		};
		if (sealedBytes !== m.sealed.bytes) throw new IntegrityError(`sealed size ${sealedBytes} ≠ manifest ${m.sealed.bytes}`);
		check('sealed', sealedHash.digest('hex'), m.sealed.sha256);
		check('compressed', compHash.digest('hex'), m.compressed.sha256);
		if (rawBytes !== m.raw.bytes) throw new IntegrityError(`raw size ${rawBytes} ≠ manifest ${m.raw.bytes}`);
		check('raw', rawHash.digest('hex'), m.raw.sha256);
		await rename(partial, opts.outPath);
		return { bytes: rawBytes };
	} catch (e) {
		unzstd.destroy();
		out.destroy();
		await rm(partial, { force: true });
		throw e;
	}
}
