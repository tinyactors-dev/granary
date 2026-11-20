/**
 * `collector/main` — the OTLP receiver's memory (ADR 0135): every accepted
 * batch (traces, logs, metrics) with who sent it (`direct`, `exe-token`,
 * `exe-peer`), its size, service and a decoded summary (span names, log
 * bodies, metric names) for assertions. Keeps the newest MAX_BATCHES.
 */
import { handlerChart } from '../../src/lib/charts';
import type { Static } from '@sinclair/typebox';
import type { FakeOtlpBatch } from '../schemas';

export const COLLECTOR_ADDRESS = 'collector/main';
export const MAX_BATCHES = 2000;

export type OtlpBatch = Static<typeof FakeOtlpBatch>;

export interface CollectorData {
	batches: OtlpBatch[];
	total: number;
}

export const COLLECTOR_EVENTS = { record: 'otlp.record' } as const;

export const collectorChart = handlerChart<CollectorData>({
	name: 'collector',
	initial: { batches: [], total: 0 },
	handlers: {
		[COLLECTOR_EVENTS.record]: (d, e: { batch: OtlpBatch }) => {
			d.batches.push(e.batch);
			d.total += 1;
			const max = 2000; // MAX_BATCHES (a helper cannot read module scope)
			if (d.batches.length > max) d.batches.splice(0, d.batches.length - max);
			return { ok: true, total: d.total };
		}
	}
});
