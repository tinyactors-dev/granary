/**
 * `watchdog/main` — the control loop's clock (ADR 0082, 0100, 0101, 0123).
 *
 *   running (entry: tick after intervalMs)
 *     ──watchdog.tick──▶ running (re-entered: next tick),
 *        action: <send type="sample"> watchdog.sample
 *
 * The `sample` I/O processor reads host health, disk, ops.sqlite and sink
 * states, and posts `signal.sample` to every `condition/<id>`. Keeping the
 * reads in a processor keeps the chart free of side effects.
 */
import { statechart, type DefinitionBuilder, type EvaluationContext } from '@tinyactors/node';
import { OPS_FAMILY, SEND_ID } from '../schemas/events';

export const WATCHDOG_REVISION = 'v1';
export const SAMPLE_IO_TYPE = 'sample';
export const WATCHDOG_SAMPLE_EVENT = 'watchdog.sample';
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;

export interface WatchdogData {
	intervalMs: number;
	/** Delay of the first tick after boot. */
	firstTickMs: number;
	ticks: number;
	lastTickAt: number | null;
}

type Ctx = EvaluationContext<WatchdogData>;

export function watchdogChart(): DefinitionBuilder<WatchdogData> {
	return statechart<WatchdogData>({ family: OPS_FAMILY.watchdog, revision: WATCHDOG_REVISION, name: 'watchdog' })
		.data('intervalMs', DEFAULT_WATCHDOG_INTERVAL_MS)
		.data('firstTickMs', 5_000)
		.data('ticks', 0)
		.data('lastTickAt', null)
		.initial('running')
		.state('running', (s) =>
			s
				.entry((a) =>
					a.send('watchdog.tick', (b) =>
						b.id(SEND_ID.tick).after(({ data }: Ctx) => (data.ticks === 0 ? data.firstTickMs : data.intervalMs))
					)
				)
				.exit((a) => a.cancel(SEND_ID.tick))
				.on('watchdog.tick', (t) =>
					t
						.target('running')
						.script(({ data }: Ctx) => {
							data.ticks++;
							data.lastTickAt = Date.now();
						})
						.send(WATCHDOG_SAMPLE_EVENT, (b) => b.via(SAMPLE_IO_TYPE).data(({ data }: Ctx) => ({ tick: data.ticks })))
				)
				// Sample now (OpsBackend / tests) without disturbing the schedule.
				.on('watchdog.sample-now', (t) =>
					t.internal().send(WATCHDOG_SAMPLE_EVENT, (b) => b.via(SAMPLE_IO_TYPE).data(({ data }: Ctx) => ({ tick: data.ticks })))
				)
		);
}
