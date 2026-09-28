/**
 * Ops-internal composition seam (ADR 0109). NOT part of the granary contract.
 *
 * Each parallel build agent delivers one feature; `index.ts` (owned by the
 * telemetry/health agent) creates the ops System, merges the features' I/O
 * processors and loaders, defines their charts, starts them, and composes
 * the OpsBackend from their partial backends.
 */
import type { Database } from 'bun:sqlite';
import type { IOProcessor, Invoker, LoadResult, LoaderOptions, System, ActorAddress } from '@tinyactors/node';
import type { OpsBackendBackups, OpsBackendHealth, OpsHost, TelemetrySink } from './contract';
import type { RemediationAction } from './schemas/conditions';

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
	system: System;
	now(): number;
	secrets: SecretReader;
	redactor: Redactor;
	/** Post into the ops System (e.g. config.changed after a DB commit). */
	post(target: ActorAddress, event: string, data?: unknown): void;
	/**
	 * Spawn a named actor and remember its address for `listOpsActors` and
	 * trace attribution (additive, ADR 0120). Prefer it over `system.spawn`.
	 */
	spawn<Data extends object>(definition: import('@tinyactors/node').Definition<Data>, address: ActorAddress, binding?: Partial<Data>): import('@tinyactors/node').Actor<Data>;
	/** Never export spans of this definition (telemetry loop breaking, ADR 0093/0120). */
	excludeFromTraces?(definition: import('@tinyactors/node').Definition<object>): void;
	/** Addresses the ops System has spawned or loaded (ADR 0150), for naming actors in listings. */
	addresses?(): ActorAddress[];
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
	invokers?: Record<string, Invoker>;
	/** Loaders for virtual families (e.g. backup-run, upload). */
	loaders?: Record<string, { load: (ctx: OpsContext, address: ActorAddress) => LoadResult | Promise<LoadResult>; options?: LoaderOptions }>;
	/** Define charts, spawn long-lived actors, run seeds. Called after all features' io are registered. */
	start(ctx: OpsContext): Promise<void>;
	stop(): Promise<void>;
	backend(ctx: OpsContext): Backend;
}

export type BackupsFeature = OpsFeature<OpsBackendBackups> & { secrets(ctx: Omit<OpsContext, 'secrets' | 'system' | 'post' | 'spawn'>): SecretReader };
export type HealthFeature = OpsFeature<OpsBackendHealth> & { redactor(): Redactor; telemetrySink(ctx: OpsContext): TelemetrySink };
