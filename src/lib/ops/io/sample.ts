/**
 * `sample` I/O processor (ADR 0100, 0123): one watchdog pass. Measures
 * (health/signals.ts), posts `signal.sample` to the affected
 * `condition/<id>` actors, and clears conditions whose subject vanished
 * (e.g. a deleted sink). A cleared sample is only posted to conditions that
 * already exist, so healthy subjects don't create actors.
 */
import type { IOProcessor } from '@tinyactors/node';
import { conditionAddress } from '../schemas/events';
import type { Journal } from '../health/journal';
import { measure, type Measurements, type SamplerDeps } from '../health/signals';
import type { OpsLogger } from '../contract';

export function sampleProcessor(deps: {
	sampler: () => SamplerDeps;
	journal: Journal;
	resident: (conditionId: string) => boolean;
	onMeasured: (m: Measurements) => void;
	log: OpsLogger;
}): IOProcessor {
	return {
		send(_request, effect) {
			let m: Measurements;
			try {
				m = measure(deps.sampler());
			} catch (e) {
				deps.log.error('ops watchdog: sampling failed', e);
				return;
			}
			deps.onMeasured(m);
			const seen = new Set<string>();
			for (const s of m.samples) {
				seen.add(s.conditionId);
				if (!s.breached && !deps.journal.hasRow(s.conditionId) && !deps.resident(s.conditionId)) continue;
				try {
					effect.post(conditionAddress(s.conditionId), 'signal.sample', {
						conditionId: s.conditionId,
						breached: s.breached,
						value: s.value,
						facts: s.facts,
						at: m.at
					});
				} catch (e) {
					deps.log.warn(`ops watchdog: could not post sample to ${s.conditionId}`, e instanceof Error ? e.message : e);
				}
			}
			for (const id of deps.journal.nonOkIds()) {
				if (seen.has(id)) continue;
				try {
					effect.post(conditionAddress(id), 'signal.sample', { conditionId: id, breached: false, value: null, facts: { gone: true }, at: m.at });
				} catch {
					/* ignore */
				}
			}
		}
	};
}
