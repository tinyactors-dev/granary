/**
 * Ops actor families, addresses and the message catalogue (ADR 0082, 0101).
 * Every event name here has a TypeBox data schema; actors validate inbound
 * data with `parseOpsEventData`. Actor data holds secret *references* only.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { parse } from '../../schemas/standard';
import { Bytes, DatabaseId, OpsId, Timestamp } from './common';
import { ConditionId, RemediationAction } from './conditions';
import { BackupManifest } from './manifest';
import { StoreError } from './runs';
import { TelemetryContentType } from './host';
import { TelemetrySignal } from './sinks';

export const OPS_FAMILY = {
	config: 'ops-config',
	plan: 'backup-plan',
	run: 'backup-run',
	upload: 'upload',
	retention: 'retention',
	drill: 'restore-drill',
	sink: 'telemetry-sink',
	watchdog: 'watchdog',
	condition: 'condition',
	remediator: 'remediator'
} as const;
export type OpsFamily = (typeof OPS_FAMILY)[keyof typeof OPS_FAMILY];

export interface OpsAddress {
	family: OpsFamily;
	name: string;
}
export const OPS_CONFIG_ADDRESS: OpsAddress = { family: OPS_FAMILY.config, name: 'main' };
export const WATCHDOG_ADDRESS: OpsAddress = { family: OPS_FAMILY.watchdog, name: 'main' };
export const REMEDIATOR_ADDRESS: OpsAddress = { family: OPS_FAMILY.remediator, name: 'main' };
export const planAddress = (planId: string): OpsAddress => ({ family: OPS_FAMILY.plan, name: planId });
export const runAddress = (runId: string): OpsAddress => ({ family: OPS_FAMILY.run, name: runId });
export const uploadAddress = (runId: string, destinationId: string): OpsAddress => ({ family: OPS_FAMILY.upload, name: `${runId}.${destinationId}` });
export const retentionAddress = (destinationId: string): OpsAddress => ({ family: OPS_FAMILY.retention, name: destinationId });
export const drillAddress = (destinationId: string): OpsAddress => ({ family: OPS_FAMILY.drill, name: destinationId });
export const sinkAddress = (sinkId: string): OpsAddress => ({ family: OPS_FAMILY.sink, name: sinkId });
export const conditionAddress = (id: string): OpsAddress => ({ family: OPS_FAMILY.condition, name: id });
export const opsTargetUri = (a: OpsAddress) => `#_actor_${a.family}/${a.name}`;
export function parseUploadName(name: string): { runId: string; destinationId: string } | null {
	const i = name.indexOf('.');
	return i > 0 ? { runId: name.slice(0, i), destinationId: name.slice(i + 1) } : null;
}

/** I/O processor types (ADR 0082, 0101). The only code doing side effects. */
export const OPS_IO = { snapshot: 'snapshot', objectStore: 'object-store', otlp: 'otlp', remediate: 'remediate' } as const;

/** Delayed-send ids (cancellable). */
export const SEND_ID = { tick: 'tick', retry: 'retry', grace: 'grace', flush: 'flush', probe: 'probe' } as const;

const ConfigArea = Type.Union([Type.Literal('destination'), Type.Literal('plan'), Type.Literal('sink'), Type.Literal('budgets'), Type.Literal('secret')]);
const Empty = Type.Object({}, { additionalProperties: false });
const RawSnapshot = Type.Object({
	runId: OpsId,
	database: DatabaseId,
	rawPath: Type.String(),
	rawBytes: Bytes,
	rawSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
	sqliteVersion: Type.String(),
	userVersion: Type.Integer(),
	pageCount: Type.Integer({ minimum: 0 }),
	rowCounts: Type.Record(Type.String(), Type.Integer({ minimum: 0 }))
});

/** Event name → data schema. Direction noted as `from → to`. */
export const OPS_EVENTS = {
	// config (OpsBackend → ops-config → affected actors)
	'config.changed': Type.Object({ area: ConfigArea, id: Type.String() }),
	'config.updated': Type.Object({ area: ConfigArea, id: Type.String(), version: Type.Integer() }),

	// scheduling (backup-plan)
	'plan.tick': Empty, // self, delayed, id=tick
	'plan.run-now': Type.Object({ requestedBy: Type.String() }), // OpsBackend → plan
	'run.start': Type.Object({ runId: OpsId, planId: OpsId, database: DatabaseId, destinationIds: Type.Array(OpsId), trigger: Type.Union([Type.Literal('schedule'), Type.Literal('catch-up'), Type.Literal('manual')]) }), // plan → run
	'run.finished': Type.Object({ runId: OpsId, state: Type.Union([Type.Literal('succeeded'), Type.Literal('partial'), Type.Literal('failed'), Type.Literal('postponed')]), sealedBytes: Type.Union([Bytes, Type.Null()]) }), // run → plan

	// snapshot I/O (run → snapshot processor → run)
	'snapshot.request': Type.Object({ runId: OpsId, database: DatabaseId, dbPath: Type.String(), spoolDir: Type.String() }),
	'snapshot.ready': RawSnapshot,
	'snapshot.failed': Type.Object({ runId: OpsId, reason: Type.Union([Type.Literal('disk-insufficient'), Type.Literal('integrity'), Type.Literal('sqlite-error'), Type.Literal('worker-crashed')]), detail: Type.String() }),

	// uploads (run → upload → retention/object-store → upload → run)
	'upload.start': Type.Object({ runId: OpsId, destinationId: OpsId, snapshot: RawSnapshot }),
	'retention.make-room': Type.Object({ destinationId: OpsId, database: DatabaseId, estimatedBytes: Bytes, runId: OpsId }), // upload → retention
	'retention.room-made': Type.Object({ runId: OpsId, deletedObjects: Type.Integer({ minimum: 0 }), freedBytes: Bytes }), // retention → upload
	'store.put-artifact': Type.Object({ runId: OpsId, destinationId: OpsId, snapshot: RawSnapshot, artifactKey: Type.String() }), // upload → object-store
	'store.artifact-stored': Type.Object({ runId: OpsId, destinationId: OpsId, manifest: BackupManifest }), // object-store → upload
	'store.put-manifest': Type.Object({ runId: OpsId, destinationId: OpsId, manifest: BackupManifest }), // upload → object-store (If-None-Match: *)
	'store.manifest-committed': Type.Object({ runId: OpsId, destinationId: OpsId, manifestKey: Type.String(), alreadyExisted: Type.Boolean() }),
	'store.error': Type.Object({ op: Type.String(), runId: Type.Union([OpsId, Type.Null()]), destinationId: OpsId, error: StoreError }),
	'upload.retry': Empty, // self, delayed, id=retry
	'upload.done': Type.Object({ runId: OpsId, destinationId: OpsId, manifestKey: Type.String(), sealedBytes: Bytes }), // upload → run
	'upload.failed': Type.Object({ runId: OpsId, destinationId: OpsId, attempts: Type.Integer(), lastError: StoreError }), // upload → run

	// retention (daily + on demand)
	'retention.tick': Empty,
	'retention.listed': Type.Object({ destinationId: OpsId, objects: Type.Integer(), manifests: Type.Integer(), bytes: Bytes }),
	'retention.pass-done': Type.Object({ destinationId: OpsId, deleted: Type.Integer(), freedBytes: Bytes, converged: Type.Boolean(), iterations: Type.Integer() }),

	// restore drills
	'drill.tick': Empty,
	'drill.run-now': Type.Object({ requestedBy: Type.String() }),
	'drill.fetched': Type.Object({ drillId: OpsId, runId: OpsId, localPath: Type.String(), bytes: Bytes }),
	'drill.checked': Type.Object({ drillId: OpsId, result: Type.String(), detail: Type.Union([Type.String(), Type.Null()]) }),

	// telemetry (fan-out → sink; sink ↔ otlp processor)
	'telemetry.batch': Type.Object({ signal: TelemetrySignal, contentType: TelemetryContentType, bytes: Type.Uint8Array(), service: Type.String(), producedAt: Timestamp }),
	'sink.flush': Empty, // self, delayed, id=flush
	'sink.sent': Type.Object({ batches: Type.Integer(), bytes: Bytes }),
	'sink.failed': Type.Object({ status: Type.Union([Type.Integer(), Type.Null()]), retryAfterMs: Type.Union([Type.Integer(), Type.Null()]), message: Type.String() }),
	'sink.probe': Empty, // self, delayed, id=probe (half-open)

	// watchdog, conditions, remediation (ADR 0100, 0101)
	'watchdog.tick': Empty,
	'signal.sample': Type.Object({ conditionId: ConditionId, breached: Type.Boolean(), value: Type.Union([Type.Number(), Type.Null()]), facts: Type.Record(Type.String(), Type.Unknown()), at: Timestamp }), // watchdog → condition
	'grace.expired': Empty, // self, delayed, id=grace
	'condition.acknowledge': Type.Object({ by: Type.String() }), // OpsBackend → condition
	remediate: Type.Object({ conditionId: ConditionId, action: RemediationAction, attempt: Type.Integer({ minimum: 1 }) }), // condition → remediator
	remediated: Type.Object({ conditionId: ConditionId, action: RemediationAction, outcome: Type.Union([Type.Literal('done'), Type.Literal('noop')]), detail: Type.String() }), // remediator → condition
	'remediation.failed': Type.Object({ conditionId: ConditionId, action: RemediationAction, error: Type.String() })
} as const satisfies Record<string, TSchema>;

export type OpsEventName = keyof typeof OPS_EVENTS;
export type OpsEventData<E extends OpsEventName> = Static<(typeof OPS_EVENTS)[E]>;

export function parseOpsEventData<E extends OpsEventName>(event: E, data: unknown): OpsEventData<E> {
	return parse(OPS_EVENTS[event] as TSchema, data, `ops event ${event}`) as OpsEventData<E>;
}

/** Done-data of finishing ops actors. */
export const RunDoneData = Type.Object({ runId: OpsId, state: Type.String(), sealedBytes: Type.Union([Bytes, Type.Null()]) });
export const UploadDoneData = Type.Object({ runId: OpsId, destinationId: OpsId, state: Type.Union([Type.Literal('done'), Type.Literal('failed')]) });
