/**
 * ops secret store (ADR 0086): the platform envelope store (ADR 0158) over
 * ops.sqlite's `secrets` table, plus ops concerns — `usedBy` (destinations
 * and telemetry sinks referencing a secret), `ops_audit` entries and
 * `OpsBackendError`s. Implements `SecretReader` for I/O processors.
 */
import type { Database } from 'bun:sqlite';
import type { Redactor, SecretReader } from '../feature';
import { OpsBackendError, type KeyStatus, type SecretMeta, type SetSecretInput } from '../contract';
import { EnvelopeSecretStore, PREVIOUS_VALUE_TTL_MS, REDACT_TTL_MS, type SecretTableRow } from '../../platform/secrets/store';
import type { MasterKeys } from '../../platform/secrets/keys';

export { PREVIOUS_VALUE_TTL_MS, REDACT_TTL_MS };

export interface SecretStoreOptions {
	db: Database;
	keys: MasterKeys;
	redactor: Redactor;
	now(): number;
	newId(prefix: string): string;
}

export class SecretStore implements SecretReader {
	readonly #o: SecretStoreOptions;
	readonly #core: EnvelopeSecretStore;

	constructor(o: SecretStoreOptions) {
		this.#o = o;
		this.#core = new EnvelopeSecretStore({
			db: o.db,
			table: 'secrets',
			keys: o.keys,
			redactor: o.redactor,
			now: o.now,
			newId: o.newId,
			keyName: 'GRANARY_MASTER_KEY (or OPS_MASTER_KEY)',
			error: (code, message) => new OpsBackendError(code, message),
			audit: (e) =>
				o.db
					.query('INSERT INTO ops_audit (at, actor, action, area, target_id, detail) VALUES (?,?,?,?,?,?)')
					.run(e.at, e.actor, e.action, 'secret', e.id, e.detail ? JSON.stringify(e.detail) : null)
		});
	}

	get keys(): MasterKeys {
		return this.#o.keys;
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

	#meta(row: SecretTableRow, usedBy: Map<string, { area: string; id: string }[]>): SecretMeta {
		const m = this.#core.metaOf(row);
		return {
			...m,
			kind: m.kind as SecretMeta['kind'],
			lastUsedOk: row.last_used_ok === null ? null : row.last_used_ok === 1,
			usedBy: usedBy.get(row.id) ?? []
		};
	}

	list(): SecretMeta[] {
		const used = this.#usedBy();
		return this.#core.rows().map((r) => this.#meta(r, used));
	}

	get(id: string): SecretMeta | null {
		const r = this.#core.row(id);
		return r ? this.#meta(r, this.#usedBy()) : null;
	}

	exists(id: string): boolean {
		return this.#core.has(id);
	}

	/** `createId`: create under a fixed id (seeds) — the id is part of the AAD, so it can't be renamed later. */
	async set(input: SetSecretInput, actor: string, opts: { createId?: string } = {}): Promise<SecretMeta> {
		const meta = await this.#core.write({ id: input.id, name: input.name, kind: input.kind, value: input.value }, actor, opts);
		return this.get(meta.id)!;
	}

	delete(id: string, actor: string): void {
		const meta = this.get(id);
		if (!meta) throw new OpsBackendError('not-found', `secret ${id} not found`);
		if (meta.usedBy.length) throw new OpsBackendError('conflict', `secret ${id} is still referenced by ${meta.usedBy.map((u) => `${u.area} ${u.id}`).join(', ')}`);
		this.#core.delete(id, actor);
	}

	reveal(secretRef: string, purpose: string): Promise<string> {
		return this.#core.reveal(secretRef, purpose);
	}

	recordUse(secretRef: string, ok: boolean): void {
		this.#core.recordUse(secretRef, ok);
	}

	withCandidates<T>(candidates: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
		return this.#core.withCandidates(candidates, fn);
	}

	rewrapAndExpire(): Promise<{ rewrapped: number; expired: number; unreadable: number }> {
		return this.#core.rewrapAndExpire();
	}

	keyStatus(backupsOnMissingKek: number): KeyStatus {
		const k = this.#o.keys;
		return { master: k.status, kekId: k.current?.id ?? null, previousKekPresent: !!k.previous, secretsOnPreviousKek: this.#core.countOnPreviousKek(), backupsOnMissingKek };
	}
}
