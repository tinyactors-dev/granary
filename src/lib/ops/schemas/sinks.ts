/** Telemetry sinks (ADR 0085, 0099, 0107). OTLP/HTTP protobuf only. */
import { Type, type Static } from '@sinclair/typebox';
import { ConfigMeta, GiB, OpsId, SecretRef } from './common';

export const SinkAuth = Type.Union([
	/** exe.dev VM-to-VM peer integration: key injected at the edge; no credential stored. */
	Type.Object({ mode: Type.Literal('exe-peer') }, { additionalProperties: false }),
	/** exe.dev VM token sent as `X-Exedev-Authorization: Bearer …`. */
	Type.Object({ mode: Type.Literal('exe-vm-token'), token: SecretRef }, { additionalProperties: false }),
	Type.Object({ mode: Type.Literal('none') }, { additionalProperties: false }),
	Type.Object({ mode: Type.Literal('bearer'), token: SecretRef }, { additionalProperties: false }),
	Type.Object(
		{ mode: Type.Literal('basic'), username: Type.String({ minLength: 1 }), password: SecretRef },
		{ additionalProperties: false }
	),
	Type.Object(
		{ mode: Type.Literal('header'), header: Type.String({ pattern: '^[A-Za-z0-9-]+$' }), value: SecretRef },
		{ additionalProperties: false }
	)
]);
export type SinkAuth = Static<typeof SinkAuth>;

export const TelemetrySignal = Type.Union([Type.Literal('traces'), Type.Literal('logs'), Type.Literal('metrics')]);
export type TelemetrySignal = Static<typeof TelemetrySignal>;

export const TelemetrySinkConfig = Type.Object(
	{
		...ConfigMeta,
		kind: Type.Literal('otlp-http'),
		/** Base URL; `/v1/<signal>` is appended. */
		endpoint: Type.String({ pattern: '^https?://[^\\s]+$' }),
		auth: SinkAuth,
		signals: Type.Array(TelemetrySignal, { minItems: 1, uniqueItems: true }),
		/** Monthly volume cap protecting the Grafana VM (ADR 0107); not egress. */
		volumeBudgetBytesPerMonth: Type.Integer({ minimum: 64 * 1024 ** 2, maximum: 100 * GiB, default: 5 * GiB }),
		maxBufferBytes: Type.Integer({ minimum: 1024 ** 2, maximum: 256 * 1024 ** 2, default: 8 * 1024 ** 2 }),
		flushIntervalMs: Type.Integer({ minimum: 250, maximum: 60_000, default: 2_000 }),
		/** Link for humans, e.g. https://granary-grafana.exe.xyz/explore */
		grafanaUrl: Type.Optional(Type.String({ pattern: '^https?://' })),
		/**
		 * Also export ops' own telemetry (`service.name=granary-ops`) to this sink.
		 * Absent = true; false sends only granary's own telemetry (ADR 0122).
		 */
		exportOps: Type.Optional(Type.Boolean()),
		lastTest: Type.Union([Type.Null(), Type.Object({ at: Type.Integer(), ok: Type.Boolean(), versionTested: Type.Integer() })])
	},
	{ additionalProperties: false }
);
export type TelemetrySinkConfig = Static<typeof TelemetrySinkConfig>;

export const TelemetrySinkDraft = Type.Object(
	{
		id: Type.Optional(OpsId),
		name: ConfigMeta.name,
		enabled: Type.Boolean(),
		endpoint: TelemetrySinkConfig.properties.endpoint,
		auth: SinkAuth,
		signals: TelemetrySinkConfig.properties.signals,
		volumeBudgetBytesPerMonth: TelemetrySinkConfig.properties.volumeBudgetBytesPerMonth,
		grafanaUrl: TelemetrySinkConfig.properties.grafanaUrl,
		exportOps: TelemetrySinkConfig.properties.exportOps,
		version: Type.Optional(Type.Integer({ minimum: 1 }))
	},
	{ additionalProperties: false }
);
export type TelemetrySinkDraft = Static<typeof TelemetrySinkDraft>;

/** Header exe.dev's proxy consumes (https://exe.dev/docs/https-tokens-for-vms.md). */
export const EXE_AUTH_HEADER = 'X-Exedev-Authorization';
