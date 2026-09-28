/** OpsStatus — what granary and the UI get back (ADR 0080, 0100). */
import { Type, type Static } from '@sinclair/typebox';
import { Bytes, DatabaseId, OpsId, Timestamp } from './common';
import { DrillResult } from './runs';

export const OpsMode = Type.Union([
	Type.Literal('ok'),
	/** e.g. master key missing: config readable, nothing needing secrets runs. */
	Type.Literal('degraded'),
	/** Ops not started (or failed to start). */
	Type.Literal('inactive')
]);

export const OpsStatus = Type.Object({
	at: Timestamp,
	mode: OpsMode,
	/** No attention items open AND a verified off-site backup within window AND last drill passed. */
	sleepOk: Type.Boolean(),
	reasons: Type.Array(Type.String()),
	attentionCount: Type.Integer({ minimum: 0 }),
	handledLast24h: Type.Integer({ minimum: 0 }),
	backups: Type.Array(
		Type.Object({
			database: DatabaseId,
			destinationId: OpsId,
			destinationKind: Type.Union([Type.Literal('r2'), Type.Literal('s3'), Type.Literal('local-dir')]),
			offsite: Type.Boolean(),
			lastVerifiedAt: Type.Union([Timestamp, Type.Null()]),
			lastVerifiedBytes: Type.Union([Bytes, Type.Null()]),
			withinWindow: Type.Boolean()
		})
	),
	lastDrill: Type.Union([Type.Null(), Type.Object({ at: Timestamp, result: DrillResult, destinationId: OpsId })]),
	telemetry: Type.Array(
		Type.Object({
			sinkId: OpsId,
			state: Type.Union([Type.Literal('idle'), Type.Literal('sending'), Type.Literal('backoff'), Type.Literal('open'), Type.Literal('half-open'), Type.Literal('disabled')]),
			lastSuccessAt: Type.Union([Timestamp, Type.Null()]),
			droppedLast24h: Type.Integer({ minimum: 0 })
		})
	)
});
export type OpsStatus = Static<typeof OpsStatus>;
