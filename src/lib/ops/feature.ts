/**
 * Ops-internal composition seam (ADR 0109). NOT part of the granary contract.
 *
 * Each feature delivers its charts, I/O processors and the spawners of its
 * virtual families; `index.ts` creates the ops host from all of them, starts
 * the features, resumes their unfinished work, and composes the OpsBackend
 * from their partial backends.
 */
import type { Database } from 'bun:sqlite';
import type { IOProcessor, Source } from '@tinyactors/node';
import type { OpsBackendBackups, OpsBackendHealth, OpsHost, TelemetrySink } from './contract';
import type { RemediationAction } from './schemas/conditions';
import type { OpsAddress } from './schemas/events';
import type { OpsActors, Spawner } from './system';

/** Read access to secrets for I/O processors only (ADR 0086). Implemented by the backups feature. */
export interface SecretReader {
	/** Decrypt at the moment of use; registers the value with the redactor for `ttlMs`. */
	reveal(secretRef: string, purpose: string): Promise<string>;
	/** Mark last use (ok/failed) for the UI. */
	recordUse(secretRef: string, ok: boolean): void;
}

/** Redaction registry (ADR 0093). Implemented by the health/telemetry feature. */
export interface Redactor {
	registerSecretValue(value: string, ref: string, ttlMs: number): void;
	redact(text: string): string;
}

export interface OpsContext {
	host: OpsHost;
	db: Database;
	/** The ops tinyactors host and its named actors (`system.ts`). */
	actors: OpsActors;
	now(): number;
	secrets: SecretReader;
	redactor: Redactor;
	/**
	 * Send into the ops host (e.g. config.changed after a DB commit), spawning
	 * a virtual actor from its row when needed. Never throws: an actor that
	 * is not there is logged.
	 */
	post(target: OpsAddress, event: string, data?: unknown): void;
}

/** A self-healing action contributed by a feature (ADR 0101, 0123). Idempotent; never throws for "nothing to do". */
export type RemediationHandler = (
	ctx: OpsContext,
	request: { conditionId: string; action: RemediationAction; attempt: number; subject: string | null }
) => Promise<{ outcome: 'done' | 'noop'; detail: string }>;

export interface OpsFeature<Backend> {
	name: string;
	/**
	 * Remediations this feature knows how to perform (additive, ADR 0123). The
	 * health feature runs them from `remediator/main`; e.g. the backups feature
	 * contributes `drop-local-copy`, `postpone-backup`, `stretch-interval`,
	 * `retry-upload` and `rerun-drill`.
	 */
	remediations?: Partial<Record<RemediationAction, RemediationHandler>>;
	/** I/O processors by type (keys from OPS_IO). */
	io: Record<string, IOProcessor>;
	/** The feature's charts (one per actor family), compiled with the ops host. */
	charts: Source[];
	/**
	 * Virtual families (e.g. backup-run, upload, condition): the params of
	 * `<family>/<name>` read from ops.sqlite, or null when the row is terminal
	 * or gone. `OpsActors.ensure` uses them where 0.1.0 had loaders.
	 */
	spawners?: Record<string, (ctx: OpsContext, name: string) => ReturnType<Spawner>>;
	/** After every feature started: spawn the actors of the non-terminal rows (crash recovery). */
	resume?(ctx: OpsContext): void;
	/** Spawn long-lived actors, run seeds. Called once the ops host runs every feature's charts and processors. */
	start(ctx: OpsContext): Promise<void>;
	stop(): Promise<void>;
	backend(ctx: OpsContext): Backend;
}

export type BackupsFeature = OpsFeature<OpsBackendBackups> & { secrets(ctx: Omit<OpsContext, 'secrets' | 'actors' | 'post'>): SecretReader };
export type HealthFeature = OpsFeature<OpsBackendHealth> & { redactor(): Redactor; telemetrySink(ctx: OpsContext): TelemetrySink };
