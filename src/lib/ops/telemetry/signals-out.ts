/**
 * Ops-generated telemetry (ADR 0085, 0100, 0121): log records for ops
 * events (OTLP/JSON) and a small, constant-volume metric set from the
 * watchdog's latest sample (OTLP/protobuf via tinyactors' `metricsToOTLP`).
 * Both carry `service.name=granary-ops`.
 */
import { metricsToOTLP, type Metric } from '@tinyactors/node';
import type { TelemetryBatch } from '../contract';
import type { OpsEventKind } from '../schemas/conditions';
import { OPS_SERVICE } from './fanout';

const SEVERITY: Record<OpsEventKind, [number, string]> = {
	attention: [13, 'WARN'],
	handled: [9, 'INFO'],
	info: [9, 'INFO'],
	ack: [9, 'INFO']
};

const str = (v: string) => ({ stringValue: v });

export interface OpsLogRecord {
	at: number;
	kind: OpsEventKind;
	conditionId: string | null;
	message: string;
}

export function opsLogBatch(records: OpsLogRecord[], version: string): TelemetryBatch {
	const doc = {
		resourceLogs: [
			{
				resource: { attributes: [{ key: 'service.name', value: str(OPS_SERVICE) }, { key: 'service.version', value: str(version) }] },
				scopeLogs: [
					{
						scope: { name: 'granary-ops' },
						logRecords: records.map((r) => ({
							timeUnixNano: String(BigInt(r.at) * 1_000_000n),
							observedTimeUnixNano: String(BigInt(r.at) * 1_000_000n),
							severityNumber: SEVERITY[r.kind][0],
							severityText: SEVERITY[r.kind][1],
							body: str(r.message),
							attributes: [
								{ key: 'ops.event.kind', value: str(r.kind) },
								...(r.conditionId ? [{ key: 'ops.condition.id', value: str(r.conditionId) }] : [])
							]
						}))
					}
				]
			}
		]
	};
	return {
		signal: 'logs',
		contentType: 'application/json',
		bytes: new TextEncoder().encode(JSON.stringify(doc)),
		service: OPS_SERVICE,
		producedAt: Date.now()
	};
}

export interface MetricPointInput {
	name: string;
	unit: string;
	kind: 'gauge' | 'sum';
	value: number;
	attributes?: Record<string, string>;
}

/** Group points by metric name and encode one ExportMetricsServiceRequest. */
export function opsMetricsBatch(points: MetricPointInput[], startTime: number, now: number, version: string): TelemetryBatch {
	const byName = new Map<string, Metric>();
	for (const p of points) {
		if (!Number.isFinite(p.value)) continue;
		let m = byName.get(p.name);
		if (!m) {
			m = { name: p.name, unit: p.unit, kind: p.kind, points: [] } as Metric;
			byName.set(p.name, m);
		}
		(m.points as { attributes: Record<string, string>; value: number }[]).push({ attributes: p.attributes ?? {}, value: p.value });
	}
	const bytes = metricsToOTLP({ startTime, time: now, system: {}, metrics: [...byName.values()] }, { resource: { 'service.name': OPS_SERVICE }, version });
	return { signal: 'metrics', contentType: 'application/x-protobuf', bytes, service: OPS_SERVICE, producedAt: now };
}
