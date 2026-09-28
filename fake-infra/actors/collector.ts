/**
 * `collector/main` — the OTLP receiver's memory (ADR 0135): every accepted
 * batch (traces, logs, metrics) with who sent it (`direct`, `exe-token`,
 * `exe-peer`), its size, service and a decoded summary (span names, log
 * bodies, metric names) for assertions. Keeps the newest MAX_BATCHES.
 */
import { statechart } from '@tinyactors/node';
import type { Static } from '@sinclair/typebox';
import type { FakeOtlpBatch } from '../schemas';
import { answer } from '../io/reply';

export const COLLECTOR_ADDRESS = { family: 'collector', name: 'main' } as const;
export const MAX_BATCHES = 2000;

export type OtlpBatch = Static<typeof FakeOtlpBatch>;

export interface CollectorData {
	batches: OtlpBatch[];
	total: number;
	out: unknown;
}

export const COLLECTOR_EVENTS = { record: 'otlp.record' } as const;

export const collectorChart = statechart<CollectorData>({ family: 'collector', revision: 'v1' })
	.dataExpression('batches', () => [])
	.data('total', 0)
	.data('out', null)
	.state('ready', (s) =>
		s.on(
			COLLECTOR_EVENTS.record,
			answer<CollectorData, { batch: OtlpBatch }>((d, e) => {
				d.batches.push(e.batch);
				d.total += 1;
				if (d.batches.length > MAX_BATCHES) d.batches.splice(0, d.batches.length - MAX_BATCHES);
				return { ok: true, total: d.total };
			})
		)
	);
