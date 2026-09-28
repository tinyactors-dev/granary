/**
 * granary's platform secret store (ADR 0158): an `EnvelopeSecretStore` over
 * granary.sqlite's `secrets` table under the master key (ADR 0157). Opened by
 * `boot.ts`; server code that needs a secret at the moment of use (GitHub App
 * key, webhook secret, OAuth client secret) calls `getGranarySecrets()`.
 */
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import type { PlatformSecrets } from '../platform/secrets/contract';
import { loadMasterKeys, type MasterKeys } from '../platform/secrets/keys';
import { EnvelopeSecretStore } from '../platform/secrets/store';
import { BackendError } from './backend';

const KEY = Symbol.for('granary.secrets');
const g = globalThis as { [KEY]?: { store: EnvelopeSecretStore; keys: MasterKeys } };

export async function openGranarySecrets(opts: {
	db: Database;
	env: Record<string, string | undefined>;
	dataDir: string;
	devMode: boolean;
	log?: { warn(message: string): void };
}): Promise<{ store: EnvelopeSecretStore; keys: MasterKeys }> {
	const keys = await loadMasterKeys({ env: opts.env, dataDir: opts.dataDir, devMode: opts.devMode, log: opts.log });
	const store = new EnvelopeSecretStore({
		db: opts.db,
		table: 'secrets',
		keys,
		now: Date.now,
		newId: (p) => `${p}-${randomBytes(6).toString('hex')}`,
		error: (code, message) => new BackendError(code === 'degraded' ? 'unavailable' : code, message)
	});
	await store.rewrapAndExpire();
	g[KEY] = { store, keys };
	return { store, keys };
}

/** The booted store, or null before boot / with the stub backend. */
export function granarySecretsOrNull(): PlatformSecrets | null {
	return g[KEY]?.store ?? null;
}

export function getGranarySecrets(): PlatformSecrets {
	const s = g[KEY]?.store;
	if (!s) throw new BackendError('unavailable', 'the secret store is not open (server not booted)');
	return s;
}

/** Master key status for /readyz and setup status ('missing' before boot). */
export function masterKeyStatus(): 'ok' | 'missing' {
	return g[KEY]?.keys.current ? 'ok' : 'missing';
}

export function closeGranarySecrets(): void {
	delete g[KEY];
}
