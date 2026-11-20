/**
 * `sample` I/O processor (ADR 0100, 0123): one watchdog pass. Measures
 * (health/signals.ts), sends `signal.sample` to the affected
 * `condition/<id>` actors (spawning a condition from its row when it is not
 * resident), and clears conditions whose subject vanished (e.g. a deleted
 * sink). A cleared sample is only sent to conditions that already exist, so
 * healthy subjects don't create actors.
 */
import type { IOProcessor } from '@tinyactors/node';
import type { Journal } from '../health/journal';
import { measure, type Measurements, type SamplerDeps } from '../health/signals';
import type { OpsLogger } from '../contract';

export function sampleProcessor(deps: {
	/** What a pass reads; async because the sinks' states are read from their actors. */
	sampler: () => Promise<SamplerDeps>;
	journal: Journal;
	/** Is `condition/<id>` resident? */
	resident: (conditionId: string) => boolean;
	/** Send to `condition/<id>`, spawning it from its row when needed. */
	post: (conditionId: string, event: string, data: unknown) => void;
	onMeasured: (m: Measurements) => void;
	log: OpsLogger;
}): IOProcessor {
	return {
		async receive() {
			let m: Measurements;
			try {
				m = measure(await deps.sampler());
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
					deps.post(s.conditionId, 'signal.sample', { conditionId: s.conditionId, breached: s.breached, value: s.value, facts: s.facts, at: m.at });
				} catch (e) {
					deps.log.warn(`ops watchdog: could not send a sample to ${s.conditionId}`, e instanceof Error ? e.message : e);
				}
			}
			for (const id of deps.journal.nonOkIds()) {
				if (seen.has(id)) continue;
				try {
					deps.post(id, 'signal.sample', { conditionId: id, breached: false, value: null, facts: { gone: true }, at: m.at });
				} catch {
					/* ignore */
				}
			}
		}
	};
}
