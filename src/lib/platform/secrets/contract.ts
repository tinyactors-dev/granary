/**
 * Platform secret store contract (ADR 0158). Implemented by the store moved
 * from `src/lib/ops/secrets/`; one instance per database:
 * granary.sqlite (GitHub connection secrets) and ops.sqlite (ops secrets).
 *
 * Write-only towards the UI: no DTO ever carries plaintext. `reveal` is for
 * server-side I/O code at the moment of use.
 *
 * This layer imports neither `$lib/server/**` nor `$lib/ops/**`
 * (ast-grep rule `platform-is-a-leaf`).
 */

export interface PlatformSecretMeta {
	id: string;
	name: string;
	/** Free-form kind, e.g. `github-app-private-key`, `r2-secret-access-key`. */
	kind: string;
	/** Last 4 characters + keyed-hash prefix, e.g. "…a1b2 · 3f9c02". */
	fingerprint: string;
	kekId: string;
	/** false → still wrapped by the previous master key (rewrap pending). */
	kekCurrent: boolean;
	createdAt: number;
	updatedAt: number;
	lastUsedAt: number | null;
}

export interface PlatformSetSecret {
	/** Fixed id (e.g. `github-app-private-key`); replaces the value if it exists. */
	id: string;
	name: string;
	kind: string;
	/** Up to 16 KiB (PEM keys fit). */
	value: string;
}

export interface PlatformSecrets {
	/** Encrypt and store; returns metadata only. */
	set(input: PlatformSetSecret, actor: string): Promise<PlatformSecretMeta>;
	has(id: string): boolean;
	get(id: string): PlatformSecretMeta | null;
	list(): PlatformSecretMeta[];
	delete(id: string, actor: string): void;
	/** Decrypt at the moment of use. Throws when missing or the key is unavailable. */
	reveal(id: string, purpose: string): Promise<string>;
	recordUse(id: string, ok: boolean): void;
	/** 'missing' when no master key is configured (ADR 0157). */
	keyStatus(): 'ok' | 'missing';
}

/** Master key env names (ADR 0157, 0230). */
export const MASTER_KEY_ENV = {
	current: ['GRANARY_MASTER_KEY'],
	previous: ['GRANARY_MASTER_KEY_PREVIOUS']
} as const;
