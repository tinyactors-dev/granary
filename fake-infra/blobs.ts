/**
 * Object bodies, kept outside actor data (ADR 0131). Actors hold metadata and
 * a blob id; the bytes live here, in memory. Seeded objects (ADR 0103 #13)
 * are *synthetic*: only a size, materialised as zero bytes when read.
 */
type Blob = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'synthetic'; size: number };

const blobs = new Map<string, Blob>();
let counter = 0;

const newId = () => `b${(++counter).toString(36)}`;

export function putBytes(bytes: Uint8Array): string {
	const id = newId();
	blobs.set(id, { kind: 'bytes', bytes });
	return id;
}

export function putSynthetic(size: number): string {
	const id = newId();
	blobs.set(id, { kind: 'synthetic', size });
	return id;
}

export function size(id: string): number {
	const b = blobs.get(id);
	if (!b) return 0;
	return b.kind === 'bytes' ? b.bytes.byteLength : b.size;
}

/** The bytes of a blob (synthetic blobs become zero-filled). Empty for an unknown id. */
export function read(id: string): Uint8Array {
	const b = blobs.get(id);
	if (!b) return new Uint8Array(0);
	return b.kind === 'bytes' ? b.bytes : new Uint8Array(b.size);
}

/** Concatenate blobs into a new one (multipart complete). */
export function concat(ids: string[]): string {
	const parts = ids.map(read);
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return putBytes(out);
}

/** Flip bytes of a stored blob in place (fault `corruptBody` on PUT: bit rot). */
export function corrupt(id: string): void {
	const b = blobs.get(id);
	if (b?.kind !== 'bytes' || b.bytes.byteLength === 0) return;
	b.bytes = corruptCopy(b.bytes);
}

export function corruptCopy(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(bytes);
	for (let i = 0; i < out.length; i += Math.max(1, Math.floor(out.length / 16))) out[i] = out[i]! ^ 0xff;
	return out;
}

export function drop(id: string | null | undefined): void {
	if (id) blobs.delete(id);
}

export function clear(): void {
	blobs.clear();
}

/** MD5 hex of a blob, as S3 ETags use for single-part objects. */
export function md5(bytes: Uint8Array): string {
	return new Bun.CryptoHasher('md5').update(bytes).digest('hex');
}
