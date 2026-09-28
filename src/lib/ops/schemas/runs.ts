/** Backup runs, uploads, restore drills (ADR 0082, 0101). */
import { Type, type Static } from '@sinclair/typebox';
import { Bytes, DatabaseId, OpsId, Timestamp } from './common';
import { BackupManifest } from './manifest';

/** backup-run/<runId> states (ADR 0082). */
export const RunState = Type.Union([
	Type.Literal('pending'),
	Type.Literal('snapshotting'),
	Type.Literal('uploading'),
	Type.Literal('finalizing'),
	Type.Literal('succeeded'),
	Type.Literal('partial'),
	Type.Literal('failed'),
	Type.Literal('postponed')
]);
export type RunState = Static<typeof RunState>;
export const TERMINAL_RUN_STATES: readonly RunState[] = ['succeeded', 'partial', 'failed', 'postponed'];

/** upload/<runId>.<destId> states (ADR 0082, 0098). */
export const UploadState = Type.Union([
	Type.Literal('pending'),
	Type.Literal('making-room'),
	Type.Literal('uploading'),
	Type.Literal('committing'),
	Type.Literal('verifying'),
	Type.Literal('retry-wait'),
	Type.Literal('done'),
	Type.Literal('failed')
]);
export type UploadState = Static<typeof UploadState>;

export const StoreErrorCode = Type.Union([
	Type.Literal('auth'), // SignatureDoesNotMatch, InvalidAccessKeyId, AccessDenied
	Type.Literal('no-bucket'),
	Type.Literal('clock-skew'),
	Type.Literal('rate-limited'),
	Type.Literal('quota'),
	Type.Literal('conflict'), // 412 on conditional manifest PUT
	Type.Literal('server'),
	Type.Literal('network'),
	Type.Literal('integrity'),
	Type.Literal('other')
]);
export type StoreErrorCode = Static<typeof StoreErrorCode>;

export const StoreError = Type.Object({
	code: StoreErrorCode,
	retryable: Type.Boolean(),
	status: Type.Union([Type.Integer(), Type.Null()]),
	providerCode: Type.Union([Type.String(), Type.Null()]),
	message: Type.String(),
	retryAfterMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])
});
export type StoreError = Static<typeof StoreError>;

export const UploadSummary = Type.Object({
	runId: OpsId,
	destinationId: OpsId,
	state: UploadState,
	attempts: Type.Integer({ minimum: 0 }),
	nextAttemptAt: Type.Union([Timestamp, Type.Null()]),
	uploadedBytes: Bytes,
	artifactKey: Type.Union([Type.String(), Type.Null()]),
	lastError: Type.Union([StoreError, Type.Null()]),
	updatedAt: Timestamp
});
export type UploadSummary = Static<typeof UploadSummary>;

export const BackupRunSummary = Type.Object({
	id: OpsId,
	planId: OpsId,
	database: DatabaseId,
	state: RunState,
	attempt: Type.Integer({ minimum: 1 }),
	trigger: Type.Union([Type.Literal('schedule'), Type.Literal('catch-up'), Type.Literal('manual')]),
	startedAt: Timestamp,
	finishedAt: Type.Union([Timestamp, Type.Null()]),
	rawBytes: Type.Union([Bytes, Type.Null()]),
	sealedBytes: Type.Union([Bytes, Type.Null()]),
	destinations: Type.Array(Type.Object({ destinationId: OpsId, state: UploadState })),
	error: Type.Union([Type.String(), Type.Null()])
});
export type BackupRunSummary = Static<typeof BackupRunSummary>;

export const BackupRunDetail = Type.Object({
	run: BackupRunSummary,
	uploads: Type.Array(UploadSummary),
	manifest: Type.Union([BackupManifest, Type.Null()])
});
export type BackupRunDetail = Static<typeof BackupRunDetail>;

export const DrillResult = Type.Union([
	Type.Literal('ok'),
	Type.Literal('download-failed'),
	Type.Literal('checksum-mismatch'),
	Type.Literal('decrypt-failed'),
	Type.Literal('integrity-failed'),
	Type.Literal('row-count-mismatch'),
	Type.Literal('not-encrypted'),
	Type.Literal('no-backup')
]);
export type DrillResult = Static<typeof DrillResult>;

export const RestoreDrillSummary = Type.Object({
	id: OpsId,
	destinationId: OpsId,
	database: DatabaseId,
	runId: Type.Union([OpsId, Type.Null()]),
	startedAt: Timestamp,
	finishedAt: Type.Union([Timestamp, Type.Null()]),
	result: Type.Union([DrillResult, Type.Null()]),
	detail: Type.Union([Type.String(), Type.Null()]),
	/** Age of the restored backup at drill time (RPO actually achieved). */
	rpoMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	/** Download+decrypt+check duration (RTO estimate). */
	rtoMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])
});
export type RestoreDrillSummary = Static<typeof RestoreDrillSummary>;
