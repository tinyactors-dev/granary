/**
 * Envelope-encrypted secret store (ADR 0086, 0158), parameterised by a
 * `Database` and table name so granary.sqlite and ops.sqlite each have one.
 *
 * Each secret has its own random DEK; the value is AES-256-GCM encrypted under
 * the DEK with AAD `secret:<id>:<name>`, and the DEK is wrapped under the KEK
 * with AAD `secret-dek:<id>` (ciphertexts can't be moved between rows).
 * Nothing returns plaintext except `reveal`, meant for server-side I/O code at
 * the moment of use; revealed values are registered with the redactor.
 */
import type { Database } from 'bun:sqlite';
import type { PlatformSecretMeta, PlatformSecrets, PlatformSetSecret } from './contract';
import {
	IV_BYTES,
	KEY_BYTES,
	aesGcmDecrypt,
	aesGcmEncrypt,
	hmacSha256Hex,
	importAesKey,
	randomBytes,
	secretAad,
	secretDekAad,
	unwrapKey,
	utf8,
	wrapKey
} from './crypto';
import type { Kek, MasterKeys } from './keys';

/** Replaced values stay decryptable this long (in-flight uploads, ADR 0086). */
export const PREVIOUS_VALUE_TTL_MS = 24 * 3_600_000;
/** How long a revealed value is registered with the redactor. */
export const REDACT_TTL_MS = 10 * 60_000;

/** Columns of a secrets table (same layout in both databases, see `secretsTableSql`). */
export interface SecretTableRow {
	id: string;
	name: string;
	kind: string;
	ciphertext: Uint8Array;
	iv: Uint8Array;
	wrapped_dek: Uint8Array;
	kek_id: string;
	fingerprint: string;
	previous_ciphertext: Uint8Array | null;
	previous_iv: Uint8Array | null;
	previous_wrapped_dek: Uint8Array | null;
	previous_kek_id: string | null;
	previous_expires_at: number | null;
	created_at: number;
	updated_at: number;
	last_used_at: number | null;
	last_used_ok: number | null;
}

/** DDL for a secrets table named `table` (ops.sqlite's `secrets` predates this helper and matches it). */
export const secretsTableSql = (table: string): string => `
CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  ciphertext BLOB NOT NULL, iv BLOB NOT NULL, wrapped_dek BLOB NOT NULL, kek_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, previous_ciphertext BLOB, previous_iv BLOB, previous_wrapped_dek BLOB, previous_kek_id TEXT,
  previous_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_used_at INTEGER, last_used_ok INTEGER);`;

export type SecretErrorCode = 'not-found' | 'conflict' | 'degraded';

export interface SecretAuditEntry {
	at: number;
	actor: string;
	action: 'secret.create' | 'secret.replace' | 'secret.delete' | 'secret.reveal' | 'secret.rewrap';
	id: string;
	detail: Record<string, unknown> | null;
}

export interface EnvelopeSecretStoreOptions {
	db: Database;
	/** Table name (identifier, not user input). Default `secrets`. */
	table?: string;
	keys: MasterKeys;
	redactor?: { registerSecretValue(value: string, ref: string, ttlMs: number): void };
	now(): number;
	newId(prefix: string): string;
	/** Called inside the write transaction (ops: `ops_audit`, granary: nothing — see `audit_log`). */
	audit?(entry: SecretAuditEntry): void;
	/** Error factory, so each module keeps its own error type (e.g. OpsBackendError). */
	error(code: SecretErrorCode, message: string): Error;
	/** Name of the key env var for messages. */
	keyName?: string;
}

type Encrypted = { ciphertext: Uint8Array; iv: Uint8Array; wrapped_dek: Uint8Array; kek_id: string };

export class EnvelopeSecretStore implements PlatformSecrets {
	readonly #o: EnvelopeSecretStoreOptions;
	readonly #t: string;
	/** Test-connection overlay: ref → candidate value (never persisted). */
	readonly #overlays: Map<string, string>[] = [];

	constructor(o: EnvelopeSecretStoreOptions) {
		this.#o = o;
		this.#t = o.table ?? 'secrets';
		if (!/^[a-z_]+$/.test(this.#t)) throw new Error(`invalid secrets table name ${this.#t}`);
	}

	get keys(): MasterKeys {
		return this.#o.keys;
	}

	#requireKek(): Kek {
		const k = this.#o.keys.current;
		if (!k) throw this.#o.error('degraded', `${this.#o.keyName ?? 'GRANARY_MASTER_KEY'} is not configured; secrets cannot be stored or used (ADR 0157)`);
		return k;
	}

	async #encrypt(id: string, name: string, value: string, kek: Kek): Promise<Encrypted> {
		const dek = randomBytes(KEY_BYTES);
		const iv = randomBytes(IV_BYTES);
		const ciphertext = await aesGcmEncrypt(await importAesKey(dek), iv, utf8(value), utf8(secretAad(id, name)));
		const wrapped_dek = await wrapKey(kek.key, dek, secretDekAad(id));
		dek.fill(0);
		return { ciphertext, iv, wrapped_dek, kek_id: kek.id };
	}

	async #decrypt(row: Pick<SecretTableRow, 'id' | 'name'> & Encrypted): Promise<string> {
		const kek = this.#o.keys.byId(row.kek_id);
		if (!kek) throw this.#o.error('degraded', `secret ${row.id} is wrapped by KEK ${row.kek_id}, which is not configured`);
		const dek = await unwrapKey(kek.key, new Uint8Array(row.wrapped_dek), secretDekAad(row.id));
		const pt = await aesGcmDecrypt(await importAesKey(dek), new Uint8Array(row.iv), new Uint8Array(row.ciphertext), utf8(secretAad(row.id, row.name)));
		dek.fill(0);
		return new TextDecoder().decode(pt);
	}

	#fingerprint(value: string): string {
		const kek = this.#requireKek();
		return `…${value.slice(-4)} · ${hmacSha256Hex(kek.raw, `fingerprint:${value}`).slice(0, 6)}`;
	}

	row(id: string): SecretTableRow | null {
		return (this.#o.db.query(`SELECT * FROM ${this.#t} WHERE id = ?`).get(id) as SecretTableRow | null) ?? null;
	}

	rows(): SecretTableRow[] {
		return this.#o.db.query(`SELECT * FROM ${this.#t} ORDER BY name`).all() as SecretTableRow[];
	}

	metaOf(row: SecretTableRow): PlatformSecretMeta {
		return {
			id: row.id,
			name: row.name,
			kind: row.kind,
			fingerprint: row.fingerprint,
			kekId: row.kek_id,
			kekCurrent: row.kek_id === this.#o.keys.current?.id,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			lastUsedAt: row.last_used_at
		};
	}

	// -- PlatformSecrets ---------------------------------------------------------------

	list(): PlatformSecretMeta[] {
		return this.rows().map((r) => this.metaOf(r));
	}

	get(id: string): PlatformSecretMeta | null {
		const r = this.row(id);
		return r ? this.metaOf(r) : null;
	}

	has(id: string): boolean {
		return !!this.#o.db.query(`SELECT 1 FROM ${this.#t} WHERE id = ?`).get(id);
	}

	keyStatus(): 'ok' | 'missing' {
		return this.#o.keys.current ? 'ok' : 'missing';
	}

	/** PlatformSecrets.set: create or replace under a fixed id. */
	async set(input: PlatformSetSecret, actor: string): Promise<PlatformSecretMeta> {
		return this.write({ name: input.name, kind: input.kind, value: input.value }, actor, { createId: input.id, upsert: true });
	}

	/**
	 * Store a value. `id` present → replace an existing secret (`not-found`
	 * otherwise, unless `upsert`); `createId` → create under a fixed id (the id
	 * is part of the AAD, so it can't be renamed later); else a new id.
	 */
	async write(
		input: { id?: string; name: string; kind: string; value: string },
		actor: string,
		opts: { createId?: string; upsert?: boolean } = {}
	): Promise<PlatformSecretMeta> {
		if (input.value.length > 16 * 1024) throw this.#o.error('conflict', 'secret value exceeds 16 KiB');
		const kek = this.#requireKek();
		const now = this.#o.now();
		const id = input.id ?? opts.createId ?? this.#o.newId('secret');
		const enc = await this.#encrypt(id, input.name, input.value, kek);
		const fingerprint = this.#fingerprint(input.value);
		const db = this.#o.db;
		const old = this.row(id);
		if (input.id && !old && !opts.upsert) throw this.#o.error('not-found', `secret ${input.id} not found`);
		db.transaction(() => {
			if (old) {
				// Keep the replaced value for PREVIOUS_VALUE_TTL_MS (credential rotation, ADR 0086).
				db.query(
					`UPDATE ${this.#t} SET name=?, kind=?, ciphertext=?, iv=?, wrapped_dek=?, kek_id=?, fingerprint=?,
					 previous_ciphertext=?, previous_iv=?, previous_wrapped_dek=?, previous_kek_id=?, previous_expires_at=?,
					 updated_at=?, last_used_at=NULL, last_used_ok=NULL WHERE id=?`
				).run(input.name, input.kind, enc.ciphertext, enc.iv, enc.wrapped_dek, enc.kek_id, fingerprint,
					old.ciphertext, old.iv, old.wrapped_dek, old.kek_id, now + PREVIOUS_VALUE_TTL_MS, now, id);
			} else {
				db.query(
					`INSERT INTO ${this.#t} (id, name, kind, ciphertext, iv, wrapped_dek, kek_id, fingerprint, created_at, updated_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?)`
				).run(id, input.name, input.kind, enc.ciphertext, enc.iv, enc.wrapped_dek, enc.kek_id, fingerprint, now, now);
			}
			this.#o.audit?.({ at: now, actor, action: old ? 'secret.replace' : 'secret.create', id, detail: { kind: input.kind, fingerprint } });
		})();
		return this.get(id)!;
	}

	delete(id: string, actor: string): void {
		if (!this.has(id)) throw this.#o.error('not-found', `secret ${id} not found`);
		const now = this.#o.now();
		this.#o.db.transaction(() => {
			this.#o.db.query(`DELETE FROM ${this.#t} WHERE id = ?`).run(id);
			this.#o.audit?.({ at: now, actor, action: 'secret.delete', id, detail: null });
		})();
	}

	/** Decrypt at the moment of use; the value is registered with the redactor. */
	async reveal(secretRef: string, purpose: string): Promise<string> {
		for (let i = this.#overlays.length - 1; i >= 0; i--) {
			const v = this.#overlays[i]!.get(secretRef);
			if (v !== undefined) {
				this.#o.redactor?.registerSecretValue(v, secretRef, REDACT_TTL_MS);
				return v;
			}
		}
		this.#requireKek();
		const row = this.row(secretRef);
		if (!row) throw this.#o.error('not-found', `secret ${secretRef} not found`);
		const value = await this.#decrypt(row);
		this.#o.redactor?.registerSecretValue(value, secretRef, REDACT_TTL_MS);
		this.#o.audit?.({ at: this.#o.now(), actor: purpose.split(':')[0] ?? purpose, action: 'secret.reveal', id: secretRef, detail: { purpose } });
		return value;
	}

	recordUse(secretRef: string, ok: boolean): void {
		this.#o.db.query(`UPDATE ${this.#t} SET last_used_at = ?, last_used_ok = ? WHERE id = ?`).run(this.#o.now(), ok ? 1 : 0, secretRef);
	}

	/** Run `fn` with unsaved candidate values visible to `reveal` (test connection, ADR 0086). */
	async withCandidates<T>(candidates: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
		if (!candidates || !Object.keys(candidates).length) return fn();
		const overlay = new Map(Object.entries(candidates));
		this.#overlays.push(overlay);
		try {
			return await fn();
		} finally {
			const i = this.#overlays.indexOf(overlay);
			if (i >= 0) this.#overlays.splice(i, 1);
			overlay.clear();
		}
	}

	/**
	 * Boot: rewrap DEKs still wrapped by the previous master key under the
	 * current KEK (values untouched) and drop expired previous values.
	 */
	async rewrapAndExpire(): Promise<{ rewrapped: number; expired: number; unreadable: number }> {
		const cur = this.#o.keys.current;
		const now = this.#o.now();
		const db = this.#o.db;
		const expired = db
			.query(`UPDATE ${this.#t} SET previous_ciphertext=NULL, previous_iv=NULL, previous_wrapped_dek=NULL, previous_kek_id=NULL, previous_expires_at=NULL WHERE previous_expires_at IS NOT NULL AND previous_expires_at < ?`)
			.run(now).changes;
		if (!cur) return { rewrapped: 0, expired, unreadable: 0 };
		let rewrapped = 0;
		let unreadable = 0;
		for (const row of db.query(`SELECT * FROM ${this.#t} WHERE kek_id != ?`).all(cur.id) as SecretTableRow[]) {
			const old = this.#o.keys.byId(row.kek_id);
			if (!old) {
				unreadable++;
				continue;
			}
			const dek = await unwrapKey(old.key, new Uint8Array(row.wrapped_dek), secretDekAad(row.id));
			const wrapped = await wrapKey(cur.key, dek, secretDekAad(row.id));
			dek.fill(0);
			db.query(`UPDATE ${this.#t} SET wrapped_dek = ?, kek_id = ?, updated_at = ? WHERE id = ?`).run(wrapped, cur.id, now, row.id);
			this.#o.audit?.({ at: now, actor: 'system', action: 'secret.rewrap', id: row.id, detail: { from: old.id, to: cur.id } });
			rewrapped++;
		}
		return { rewrapped, expired, unreadable };
	}

	/** Rows not wrapped by the current KEK (all rows when there is no key). */
	countOnPreviousKek(): number {
		const cur = this.#o.keys.current?.id ?? null;
		return cur
			? (this.#o.db.query(`SELECT count(*) AS n FROM ${this.#t} WHERE kek_id != ?`).get(cur) as { n: number }).n
			: (this.#o.db.query(`SELECT count(*) AS n FROM ${this.#t}`).get() as { n: number }).n;
	}
}
