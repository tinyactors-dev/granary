/**
 * Secret store: envelope encryption in ops.sqlite (ADR 0086).
 *
 * Each secret has its own random DEK; the value is AES-256-GCM encrypted under
 * the DEK with AAD `secret:<id>:<name>`, and the DEK is wrapped under the KEK
 * with AAD `secret-dek:<id>` (ciphertexts can't be moved between rows).
 * No method returns plaintext except `reveal`, which only I/O processors call
 * (through the `SecretReader` interface) and which registers the value with
 * the redactor.
 */
import type { Database } from 'bun:sqlite';
import type { Redactor, SecretReader } from '../feature';
import { OpsBackendError, type KeyStatus, type SecretMeta, type SetSecretInput } from '../contract';
import type { SecretRow } from '../db/ddl';
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

export interface SecretStoreOptions {
	db: Database;
	keys: MasterKeys;
	redactor: Redactor;
	now(): number;
	newId(prefix: string): string;
}

type Encrypted = { ciphertext: Uint8Array; iv: Uint8Array; wrapped_dek: Uint8Array; kek_id: string };

export class SecretStore implements SecretReader {
	readonly #o: SecretStoreOptions;
	/** Test-connection overlay: ref → candidate value (never persisted). */
	readonly #overlays: Map<string, string>[] = [];

	constructor(o: SecretStoreOptions) {
		this.#o = o;
	}

	get keys(): MasterKeys {
		return this.#o.keys;
	}

	#requireKek(): Kek {
		const k = this.#o.keys.current;
		if (!k) throw new OpsBackendError('degraded', 'OPS_MASTER_KEY is not configured; secrets cannot be stored or used (ADR 0086)');
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

	async #decrypt(row: Pick<SecretRow, 'id' | 'name'> & Encrypted): Promise<string> {
		const kek = this.#o.keys.byId(row.kek_id);
		if (!kek) throw new OpsBackendError('degraded', `secret ${row.id} is wrapped by KEK ${row.kek_id}, which is not configured`);
		const dek = await unwrapKey(kek.key, new Uint8Array(row.wrapped_dek), secretDekAad(row.id));
		const pt = await aesGcmDecrypt(await importAesKey(dek), new Uint8Array(row.iv), new Uint8Array(row.ciphertext), utf8(secretAad(row.id, row.name)));
		dek.fill(0);
		return new TextDecoder().decode(pt);
	}

	#fingerprint(value: string): string {
		const kek = this.#requireKek();
		return `…${value.slice(-4)} · ${hmacSha256Hex(kek.raw, `fingerprint:${value}`).slice(0, 6)}`;
	}

	#row(id: string): SecretRow | null {
		return (this.#o.db.query('SELECT * FROM secrets WHERE id = ?').get(id) as SecretRow | null) ?? null;
	}

	/** Config items referencing a secret (destinations and telemetry sinks). */
	#usedBy(): Map<string, { area: string; id: string }[]> {
		const map = new Map<string, { area: string; id: string }[]>();
		const scan = (area: string, rows: { id: string; config: string }[]) => {
			for (const r of rows) {
				for (const m of r.config.matchAll(/"secretRef"\s*:\s*"([a-z0-9-]+)"/g)) {
					const list = map.get(m[1]!) ?? [];
					if (!list.some((x) => x.area === area && x.id === r.id)) list.push({ area, id: r.id });
					map.set(m[1]!, list);
				}
			}
		};
		scan('destination', this.#o.db.query('SELECT id, config FROM destinations').all() as { id: string; config: string }[]);
		scan('sink', this.#o.db.query('SELECT id, config FROM telemetry_sinks').all() as { id: string; config: string }[]);
		return map;
	}

	#meta(row: SecretRow, usedBy: Map<string, { area: string; id: string }[]>): SecretMeta {
		return {
			id: row.id,
			name: row.name,
			kind: row.kind as SecretMeta['kind'],
			fingerprint: row.fingerprint,
			kekId: row.kek_id,
			kekCurrent: row.kek_id === this.#o.keys.current?.id,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			lastUsedAt: row.last_used_at,
			lastUsedOk: row.last_used_ok === null ? null : row.last_used_ok === 1,
			usedBy: usedBy.get(row.id) ?? []
		};
	}

	list(): SecretMeta[] {
		const used = this.#usedBy();
		return (this.#o.db.query('SELECT * FROM secrets ORDER BY name').all() as SecretRow[]).map((r) => this.#meta(r, used));
	}

	get(id: string): SecretMeta | null {
		const r = this.#row(id);
		return r ? this.#meta(r, this.#usedBy()) : null;
	}

	exists(id: string): boolean {
		return !!this.#o.db.query('SELECT 1 FROM secrets WHERE id = ?').get(id);
	}

	/** `createId`: create under a fixed id (seeds) — the id is part of the AAD, so it can't be renamed later. */
	async set(input: SetSecretInput, actor: string, opts: { createId?: string } = {}): Promise<SecretMeta> {
		const kek = this.#requireKek();
		const now = this.#o.now();
		const id = input.id ?? opts.createId ?? this.#o.newId('secret');
		const enc = await this.#encrypt(id, input.name, input.value, kek);
		const fingerprint = this.#fingerprint(input.value);
		const db = this.#o.db;
		const old = this.#row(id);
		if (input.id && !old) throw new OpsBackendError('not-found', `secret ${input.id} not found`);
		db.transaction(() => {
			if (old) {
				// Keep the replaced value for PREVIOUS_VALUE_TTL_MS (credential rotation, ADR 0086).
				db.query(
					`UPDATE secrets SET name=?, kind=?, ciphertext=?, iv=?, wrapped_dek=?, kek_id=?, fingerprint=?,
					 previous_ciphertext=?, previous_iv=?, previous_wrapped_dek=?, previous_kek_id=?, previous_expires_at=?,
					 updated_at=?, last_used_at=NULL, last_used_ok=NULL WHERE id=?`
				).run(input.name, input.kind, enc.ciphertext, enc.iv, enc.wrapped_dek, enc.kek_id, fingerprint,
					old.ciphertext, old.iv, old.wrapped_dek, old.kek_id, now + PREVIOUS_VALUE_TTL_MS, now, id);
			} else {
				db.query(
					`INSERT INTO secrets (id, name, kind, ciphertext, iv, wrapped_dek, kek_id, fingerprint, created_at, updated_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?)`
				).run(id, input.name, input.kind, enc.ciphertext, enc.iv, enc.wrapped_dek, enc.kek_id, fingerprint, now, now);
			}
			db.query('INSERT INTO ops_audit (at, actor, action, area, target_id, detail) VALUES (?,?,?,?,?,?)').run(
				now, actor, old ? 'secret.replace' : 'secret.create', 'secret', id, JSON.stringify({ kind: input.kind, fingerprint })
			);
		})();
		return this.get(id)!;
	}

	delete(id: string, actor: string): void {
		const meta = this.get(id);
		if (!meta) throw new OpsBackendError('not-found', `secret ${id} not found`);
		if (meta.usedBy.length) throw new OpsBackendError('conflict', `secret ${id} is still referenced by ${meta.usedBy.map((u) => `${u.area} ${u.id}`).join(', ')}`);
		const now = this.#o.now();
		this.#o.db.transaction(() => {
			this.#o.db.query('DELETE FROM secrets WHERE id = ?').run(id);
			this.#o.db.query('INSERT INTO ops_audit (at, actor, action, area, target_id, detail) VALUES (?,?,?,?,?,NULL)').run(now, actor, 'secret.delete', 'secret', id);
		})();
	}

	/** SecretReader: decrypt at the moment of use; the value is registered with the redactor. */
	async reveal(secretRef: string, purpose: string): Promise<string> {
		for (let i = this.#overlays.length - 1; i >= 0; i--) {
			const v = this.#overlays[i]!.get(secretRef);
			if (v !== undefined) {
				this.#o.redactor.registerSecretValue(v, secretRef, REDACT_TTL_MS);
				return v;
			}
		}
		this.#requireKek();
		const row = this.#row(secretRef);
		if (!row) throw new OpsBackendError('not-found', `secret ${secretRef} not found`);
		const value = await this.#decrypt(row);
		this.#o.redactor.registerSecretValue(value, secretRef, REDACT_TTL_MS);
		this.#o.db.query('INSERT INTO ops_audit (at, actor, action, area, target_id, detail) VALUES (?,?,?,?,?,?)').run(
			this.#o.now(), purpose.split(':')[0] ?? purpose, 'secret.reveal', 'secret', secretRef, JSON.stringify({ purpose })
		);
		return value;
	}

	recordUse(secretRef: string, ok: boolean): void {
		this.#o.db.query('UPDATE secrets SET last_used_at = ?, last_used_ok = ? WHERE id = ?').run(this.#o.now(), ok ? 1 : 0, secretRef);
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
	 * Boot: rewrap DEKs still wrapped by OPS_MASTER_KEY_PREVIOUS under the current
	 * KEK (values untouched) and drop expired previous values. Returns counts.
	 */
	async rewrapAndExpire(): Promise<{ rewrapped: number; expired: number; unreadable: number }> {
		const cur = this.#o.keys.current;
		const now = this.#o.now();
		const db = this.#o.db;
		const expired = db.query('UPDATE secrets SET previous_ciphertext=NULL, previous_iv=NULL, previous_wrapped_dek=NULL, previous_kek_id=NULL, previous_expires_at=NULL WHERE previous_expires_at IS NOT NULL AND previous_expires_at < ?').run(now).changes;
		if (!cur) return { rewrapped: 0, expired, unreadable: 0 };
		let rewrapped = 0;
		let unreadable = 0;
		for (const row of db.query('SELECT * FROM secrets WHERE kek_id != ?').all(cur.id) as SecretRow[]) {
			const old = this.#o.keys.byId(row.kek_id);
			if (!old) {
				unreadable++;
				continue;
			}
			const dek = await unwrapKey(old.key, new Uint8Array(row.wrapped_dek), secretDekAad(row.id));
			const wrapped = await wrapKey(cur.key, dek, secretDekAad(row.id));
			dek.fill(0);
			db.query('UPDATE secrets SET wrapped_dek = ?, kek_id = ?, updated_at = ? WHERE id = ?').run(wrapped, cur.id, now, row.id);
			db.query('INSERT INTO ops_audit (at, actor, action, area, target_id, detail) VALUES (?,?,?,?,?,?)').run(now, 'system', 'secret.rewrap', 'secret', row.id, JSON.stringify({ from: old.id, to: cur.id }));
			rewrapped++;
		}
		return { rewrapped, expired, unreadable };
	}

	keyStatus(backupsOnMissingKek: number): KeyStatus {
		const k = this.#o.keys;
		const cur = k.current?.id ?? null;
		const secretsOnPreviousKek = cur
			? (this.#o.db.query('SELECT count(*) AS n FROM secrets WHERE kek_id != ?').get(cur) as { n: number }).n
			: (this.#o.db.query('SELECT count(*) AS n FROM secrets').get() as { n: number }).n;
		return { master: k.status, kekId: cur, previousKekPresent: !!k.previous, secretsOnPreviousKek, backupsOnMissingKek };
	}
}
