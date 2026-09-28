/**
 * Master key (KEK) handling (ADR 0086, 0097, 0113, 0157).
 *
 * Sources, highest first: `GRANARY_MASTER_KEY` → `<dataDir>/master.key`
 * (written by `granary init`, mode 0600). Rotation:
 * `GRANARY_MASTER_KEY_PREVIOUS`. Only in dev mode, without either, one is
 * generated into `<dataDir>/dev-master.key` (0600). Outside dev mode a missing key is never
 * generated silently → `status: 'missing'` (degraded; ADR 0157).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MASTER_KEY_ENV } from './contract';
import { KEY_BYTES, b64, hex, importAesKey, randomBytes, sha256Hex, unb64 } from './crypto';

export interface Kek {
	id: string;
	key: CryptoKey;
	/** Raw bytes, only for HMAC fingerprints. Never logged. */
	raw: Uint8Array;
}

export interface MasterKeys {
	status: 'ok' | 'missing' | 'dev-generated';
	/** Where the current key came from (for `doctor`), never the key itself. */
	source: 'env' | 'file' | 'dev-file' | null;
	current: Kek | null;
	previous: Kek | null;
	/** KEK by id (current or previous). */
	byId(id: string): Kek | null;
}

export const DEV_KEY_FILE = 'dev-master.key';
/** Written by `granary init` (ADR 0157). */
export const MASTER_KEY_FILE = 'master.key';

/** kek_id = first 8 bytes of sha256(KEK), hex (ADR 0086). */
export const kekIdOf = (raw: Uint8Array): string => sha256Hex(raw).slice(0, 16);

export function decodeKeyMaterial(text: string, name: string): Uint8Array {
	const t = text.trim();
	const bytes = /^[0-9a-fA-F]{64}$/.test(t) ? new Uint8Array(Buffer.from(t, 'hex')) : unb64(t);
	if (bytes.length !== KEY_BYTES) throw new Error(`${name} must decode to ${KEY_BYTES} bytes (base64 or hex), got ${bytes.length}`);
	return bytes;
}

/** First non-empty env var among `names` → `[name, value]`. */
export function firstEnv(env: Record<string, string | undefined>, names: readonly string[]): [string, string] | null {
	for (const n of names) {
		const v = env[n];
		if (v && v.trim()) return [n, v];
	}
	return null;
}

/** True when a master key is configured by env or `<dataDir>/master.key` (no decoding). */
export function masterKeyConfigured(env: Record<string, string | undefined>, dataDir: string): boolean {
	return !!firstEnv(env, MASTER_KEY_ENV.current) || existsSync(join(dataDir, MASTER_KEY_FILE));
}

async function toKek(raw: Uint8Array): Promise<Kek> {
	return { id: kekIdOf(raw), key: await importAesKey(raw), raw };
}

export async function loadMasterKeys(opts: {
	env: Record<string, string | undefined>;
	dataDir: string;
	devMode: boolean;
	log?: { warn(message: string): void };
}): Promise<MasterKeys> {
	const { env, dataDir, devMode } = opts;
	let status: MasterKeys['status'] = 'ok';
	let source: MasterKeys['source'] = null;
	let currentRaw: Uint8Array | null = null;
	const fromEnv = firstEnv(env, MASTER_KEY_ENV.current);
	const keyFile = join(dataDir, MASTER_KEY_FILE);
	if (fromEnv) {
		currentRaw = decodeKeyMaterial(fromEnv[1], fromEnv[0]);
		source = 'env';
	} else if (existsSync(keyFile)) {
		currentRaw = decodeKeyMaterial(readFileSync(keyFile, 'utf8'), keyFile);
		source = 'file';
	} else if (devMode) {
		const file = join(dataDir, DEV_KEY_FILE);
		if (existsSync(file)) {
			currentRaw = decodeKeyMaterial(readFileSync(file, 'utf8'), file);
		} else {
			mkdirSync(dataDir, { recursive: true });
			currentRaw = randomBytes(KEY_BYTES);
			writeFileSync(file, b64(currentRaw) + '\n', { mode: 0o600 });
			chmodSync(file, 0o600);
			opts.log?.warn(`no GRANARY_MASTER_KEY; generated a dev master key at ${file} (kek ${kekIdOf(currentRaw)})`);
		}
		status = 'dev-generated';
		source = 'dev-file';
	} else {
		status = 'missing';
	}
	const current = currentRaw ? await toKek(currentRaw) : null;
	const prevEnv = firstEnv(env, MASTER_KEY_ENV.previous);
	const previous = prevEnv ? await toKek(decodeKeyMaterial(prevEnv[1], prevEnv[0])) : null;
	return {
		status,
		source,
		current,
		previous: previous && current && previous.id === current.id ? null : previous,
		byId(id) {
			if (current?.id === id) return current;
			if (previous?.id === id) return previous;
			return null;
		}
	};
}

/** Generate fresh key material as 64 hex characters (`granary init`; base64 keys stay accepted). */
export const generateMasterKey = (): string => Buffer.from(randomBytes(KEY_BYTES)).toString('hex');
export { hex };
