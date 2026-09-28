/** What granary exposes to ops through OpsHost (ADR 0080, 0100). */
import { Type, type Static } from '@sinclair/typebox';
import { Bytes, DatabaseId, Timestamp } from './common';
import { TelemetrySignal } from './sinks';

export const HostDatabase = Type.Object({
	id: DatabaseId,
	label: Type.String(),
	/** Absolute path of the SQLite file (WAL mode). */
	path: Type.String({ minLength: 1 })
});
export type HostDatabase = Static<typeof HostDatabase>;

const AgeOrNull = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

export const HostHealthSnapshot = Type.Object({
	at: Timestamp,
	outbox: Type.Object({ pending: Type.Integer({ minimum: 0 }), inflight: Type.Integer({ minimum: 0 }), dead: Type.Integer({ minimum: 0 }), oldestPendingAgeMs: AgeOrNull }),
	inbox: Type.Object({ pending: Type.Integer({ minimum: 0 }), oldestPendingAgeMs: AgeOrNull }),
	/** Monotonic counters since process start. */
	deadLettersTotal: Type.Integer({ minimum: 0 }),
	quarantinedActors: Type.Integer({ minimum: 0 }),
	relayLastSuccessAt: Type.Union([Timestamp, Type.Null()]),
	lastWebhookAt: Type.Union([Timestamp, Type.Null()]),
	process: Type.Object({ eventLoopLagP99Ms: Type.Number({ minimum: 0 }), rssBytes: Bytes }),
	/**
	 * Missed-webhook catch-up (ADR 0162, 0220); absent when the host has
	 * none. `enabled` only in GitHub App mode.
	 */
	catchup: Type.Optional(
		Type.Object({
			enabled: Type.Boolean(),
			intervalMs: Type.Integer({ minimum: 1 }),
			lastPassAt: Type.Union([Timestamp, Type.Null()]),
			lastPassRedelivered: Type.Integer({ minimum: 0 }),
			totalRedelivered: Type.Integer({ minimum: 0 }),
			lastError: Type.Union([Type.String(), Type.Null()])
		})
	)
});
export type HostHealthSnapshot = Static<typeof HostHealthSnapshot>;

export const TelemetryContentType = Type.Union([Type.Literal('application/x-protobuf'), Type.Literal('application/json')]);

/** One OTLP export request as granary's Tracer produced it. */
export const TelemetryBatch = Type.Object({
	signal: TelemetrySignal,
	contentType: TelemetryContentType,
	bytes: Type.Uint8Array(),
	/** `service.name` of the producer, e.g. `granary` or `granary-ops`. */
	service: Type.String(),
	producedAt: Timestamp
});
export type TelemetryBatch = Static<typeof TelemetryBatch>;
