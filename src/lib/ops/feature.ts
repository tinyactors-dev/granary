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
}

export interface OpsFeature<Backend> {
	name: string;
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

export type BackupsFeature = OpsFeature<OpsBackendBackups> & { secrets(ctx: Omit<OpsContext, 'secrets' | 'system' | 'post'>): SecretReader };
export type HealthFeature = OpsFeature<OpsBackendHealth> & { redactor(): Redactor; telemetrySink(ctx: OpsContext): TelemetrySink };
