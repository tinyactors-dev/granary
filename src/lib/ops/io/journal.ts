/**
 * `journal` I/O processor (ADR 0101, 0123): persists a condition's state
 * (and the ops event its transition produced) for `condition/<id>`, then
 * exports the event as an OTLP log line. Writes are synchronous (bun:sqlite)
 * and run at the end of the pump turn, never inside core.
 */
import type { IOProcessor } from '@tinyactors/node';
import type { JournalConditionRequest } from '../actors/condition';
import type { Journal } from '../health/journal';
import type { OpsEvent } from '../schemas/conditions';
import type { OpsLogger } from '../contract';

export function journalProcessor(deps: { journal: Journal; onEvent: (e: OpsEvent) => void; log: OpsLogger }): IOProcessor {
	return {
		send(request) {
			const r = request.data as JournalConditionRequest;
			try {
				const event = deps.journal.writeCondition(
					{
						id: r.id,
						kind: r.kind,
						subject: r.subject,
						state: r.state,
						since: r.since,
						facts: r.facts,
						step: r.step,
						tried: r.tried,
						lastRemediation: r.lastRemediation,
						acknowledgedBy: r.acknowledgedBy
					},
					r.at,
					r.event
				);
				if (event) {
					deps.onEvent(event);
					if (event.kind === 'attention') deps.log.warn(`ops: needs attention (no page sent): ${event.message}`);
				}
			} catch (e) {
				deps.log.error(`ops: could not journal condition ${r.id}`, e);
			}
		}
	};
}
