/**
 * `watchdog/main` — the control loop's clock (ADR 0082, 0100, 0101, 0123).
 *
 *   running (entry: tick after intervalMs)
 *     ──watchdog.tick──▶ running (re-entered: next tick),
 *        action: <send type="sample"> watchdog.sample
 *
 * The `sample` I/O processor reads host health, disk, ops.sqlite and sink
 * states, and sends `signal.sample` to every `condition/<id>`. Keeping the
 * reads in a processor keeps the chart free of side effects.
 */
import { chart, scxml } from '../../charts';
import { OPS_FAMILY, SEND_ID } from '../schemas/events';

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

const sample = scxml`<send type="${SAMPLE_IO_TYPE}" event="${WATCHDOG_SAMPLE_EVENT}"><content expr="({ tick: ticks })"/></send>`;

export const watchdogChart = chart({
	name: OPS_FAMILY.watchdog,
	initial: 'running',
	data: { intervalMs: DEFAULT_WATCHDOG_INTERVAL_MS, firstTickMs: 5_000, ticks: 0, lastTickAt: null } satisfies WatchdogData,
	body: scxml`
<state id="running">
	<onentry><send event="watchdog.tick" id="${SEND_ID.tick}" delayexpr="(ticks === 0 ? firstTickMs : intervalMs) + 'ms'"/></onentry>
	<onexit><cancel sendid="${SEND_ID.tick}"/></onexit>
	<transition event="watchdog.tick" target="running">
		<assign location="ticks" expr="ticks + 1"/>
		<assign location="lastTickAt" expr="Date.now()"/>
		${sample}
	</transition>
	<!-- Sample now (OpsBackend / tests) without disturbing the schedule. -->
	<transition event="watchdog.sample-now">${sample}</transition>
</state>`
});
