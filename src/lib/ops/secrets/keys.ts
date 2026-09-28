/**
 * Master key (KEK) handling (ADR 0086, 0097, 0113).
 *
 * `OPS_MASTER_KEY` (base64 or hex, 32 bytes) from fnox `prod`; optional
 * `OPS_MASTER_KEY_PREVIOUS` for rotation. In dev mode without a key, one is
 * generated once into `<dataDir>/ops-master.key` (0600). Production without a
 * key → `master: 'missing'` (ops degraded; nothing that needs a secret runs).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_BYTES, b64, hex, importAesKey, randomBytes, sha256Hex, unb64 } from './crypto';

export interface Kek {
	id: string;
	key: CryptoKey;
	/** Raw bytes, only for HMAC fingerprints. Never logged. */
	raw: Uint8Array;
}

export interface MasterKeys {
	status: 'ok' | 'missing' | 'dev-generated';
	current: Kek | null;
	previous: Kek | null;
	/** KEK by id (current or previous). */
	byId(id: string): Kek | null;
}

export const DEV_KEY_FILE = 'ops-master.key';

/** kek_id = first 8 bytes of sha256(KEK), hex (ADR 0086). */
export const kekIdOf = (raw: Uint8Array): string => sha256Hex(raw).slice(0, 16);

export function decodeKeyMaterial(text: string, name: string): Uint8Array {
	const t = text.trim();
	const bytes = /^[0-9a-fA-F]{64}$/.test(t) ? new Uint8Array(Buffer.from(t, 'hex')) : unb64(t);
	if (bytes.length !== KEY_BYTES) throw new Error(`${name} must decode to ${KEY_BYTES} bytes (base64 or hex), got ${bytes.length}`);
	return bytes;
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
	let currentRaw: Uint8Array | null = null;
	if (env.OPS_MASTER_KEY) {
		currentRaw = decodeKeyMaterial(env.OPS_MASTER_KEY, 'OPS_MASTER_KEY');
	} else if (devMode) {
		const file = join(dataDir, DEV_KEY_FILE);
		if (existsSync(file)) {
			currentRaw = decodeKeyMaterial(readFileSync(file, 'utf8'), file);
		} else {
			mkdirSync(dataDir, { recursive: true });
			currentRaw = randomBytes(KEY_BYTES);
			writeFileSync(file, b64(currentRaw) + '\n', { mode: 0o600 });
			chmodSync(file, 0o600);
			opts.log?.warn(`ops: no OPS_MASTER_KEY; generated a dev master key at ${file} (kek ${kekIdOf(currentRaw)})`);
		}
		status = 'dev-generated';
	} else {
		status = 'missing';
	}
	const current = currentRaw ? await toKek(currentRaw) : null;
	const previous = env.OPS_MASTER_KEY_PREVIOUS ? await toKek(decodeKeyMaterial(env.OPS_MASTER_KEY_PREVIOUS, 'OPS_MASTER_KEY_PREVIOUS')) : null;
	return {
		status,
		current,
		previous: previous && current && previous.id === current.id ? null : previous,
		byId(id) {
			if (current?.id === id) return current;
			if (previous?.id === id) return previous;
			return null;
		}
	};
}

/** Generate fresh key material (for docs/CLI: `bun -e` helper). */
export const generateMasterKey = (): string => b64(randomBytes(KEY_BYTES));
export { hex };
