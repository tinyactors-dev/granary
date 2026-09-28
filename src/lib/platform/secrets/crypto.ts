/**
 * Crypto primitives shared by the secret store and backup sealing
 * (ADR 0086, 0097, 0113). WebCrypto AES-256-GCM everywhere; keys never leave
 * this process except wrapped.
 */
const subtle = crypto.subtle;
/** WebCrypto wants ArrayBuffer-backed views (TS 5.7+ generic Uint8Array). */
const bs = (u: Uint8Array): Uint8Array<ArrayBuffer> => u as Uint8Array<ArrayBuffer>;

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function randomBytes(n: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(n));
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.length !== KEY_BYTES) throw new Error(`AES-256 key must be ${KEY_BYTES} bytes, got ${raw.length}`);
	return subtle.importKey('raw', bs(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function aesGcmEncrypt(key: CryptoKey, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad), tagLength: 128 }, key, bs(plaintext)));
}

export async function aesGcmDecrypt(key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad), tagLength: 128 }, key, bs(ciphertext)));
}

/** Wrap a DEK under a KEK: base64(iv ‖ AES-GCM(dek, aad)). */
export async function wrapKey(kek: CryptoKey, dek: Uint8Array, aad: string): Promise<Uint8Array> {
	const iv = randomBytes(IV_BYTES);
	const ct = await aesGcmEncrypt(kek, iv, dek, utf8(aad));
	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv);
	out.set(ct, iv.length);
	return out;
}

export async function unwrapKey(kek: CryptoKey, wrapped: Uint8Array, aad: string): Promise<Uint8Array> {
	const iv = wrapped.subarray(0, IV_BYTES);
	return aesGcmDecrypt(kek, iv, wrapped.subarray(IV_BYTES), utf8(aad));
}

export function sha256Hex(data: Uint8Array | string): string {
	return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: Uint8Array, data: string): string {
	return new Bun.CryptoHasher('sha256', key).update(data).digest('hex');
}

/** Nonce for chunk `i`: nonceBase XOR big-endian(i) in the last 8 bytes (ADR 0113). */
export function chunkNonce(base: Uint8Array, i: number): Uint8Array {
	const n = new Uint8Array(base);
	let x = BigInt(i);
	for (let k = 11; k >= 4 && x > 0n; k--) {
		n[k] = n[k]! ^ Number(x & 0xffn);
		x >>= 8n;
	}
	return n;
}

/** AAD binding a sealed chunk to its run, position and finality (no truncation/reordering). */
export const chunkAad = (runId: string, i: number, last: boolean): Uint8Array => utf8(`granary-ops-backup/1|${runId}|${i}|${last ? 1 : 0}`);
export const backupDekAad = (runId: string): string => `backup-dek:${runId}`;
export const secretAad = (id: string, name: string): string => `secret:${id}:${name}`;
export const secretDekAad = (id: string): string => `secret-dek:${id}`;
