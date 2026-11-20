/**
 * `scenario/<id>` — the coordinator of one load scenario (ADR 0072).
 *
 * created → running ⇄ paused → draining → settling → finished;
 * `stop` from any non-final state → stopped.
 *
 * While running, a delayed `arrival` (id `arrival`) asks the host to spawn
 * the next planned persona, and a delayed `duration.elapsed` (id `duration`)
 * ends arrivals. Pausing cancels both and keeps the remaining time. The host
 * reports `personas.done` (every persona reached a final state and the plan
 * is exhausted) and `observer.settled` (every issue expected closed is
 * closed or overdue).
 *
 * The control events (`start`, `pause`, `resume`, `stop`) are asked: the
 * chart answers `control.ok` when it takes one and `control.ignored` when
 * its state has no use for it.
 */
import { chart, lit, reply, scxml, type Raw } from '../../src/lib/charts';
import { HOST_IO } from '../personas/common';

export const SCENARIO_FAMILY = 'scenario';
/** The scenario actor's name. */
export const scenarioName = (id: string) => `${SCENARIO_FAMILY}/${id}`;

export const SCENARIO_EVENTS = {
	start: 'start',
	pause: 'pause',
	resume: 'resume',
	stop: 'stop',
	arrival: 'arrival',
	durationElapsed: 'duration.elapsed',
	drainTimeout: 'drain.timeout',
	settleTimeout: 'settle.timeout',
	personasDone: 'personas.done',
	observerSettled: 'observer.settled'
} as const;

/** The answers to the control events. */
export const SCENARIO_REPLIES = { ok: 'control.ok', ignored: 'control.ignored' } as const;

/** Host requests (via the `host` I/O processor). */
export const SCENARIO_HOST = {
	state: 'scn.state',
	spawn: 'scn.spawn',
	stopPersonas: 'scn.stop-personas'
} as const;

export interface PlanEntry {
	atMs: number;
	kind: string;
}

export interface ScenarioData {
	id: string;
	plan: PlanEntry[];
	next: number;
	durationMs: number;
	drainTimeoutMs: number;
	settleTimeoutMs: number;
	/** Active (unpaused) running time accumulated before the current segment. */
	activeMs: number;
	/** Epoch ms when the current running segment began. */
	segmentStart: number;
	wait: number;
	note: string;
}

const DEFAULTS: ScenarioData = {
	id: '',
	plan: [],
	next: 0,
	durationMs: 60_000,
	drainTimeoutMs: 60_000,
	settleTimeoutMs: 60_000,
	activeMs: 0,
	segmentStart: 0,
	wait: 0,
	note: ''
};

/** Tell the host the scenario's state; `note` is a JavaScript expression. */
const reportState = (state: string, note: string): Raw =>
	scxml`<send type="${HOST_IO}" event="${SCENARIO_HOST.state}"><content expr="${`({state: ${lit(state)}, note: ${note}, activeMs: activeMs})`}"/></send>`;

const stopPersonas = (reason: string): Raw =>
	scxml`<send type="${HOST_IO}" event="${SCENARIO_HOST.stopPersonas}"><content expr="${`({reason: ${lit(reason)}})`}"/></send>`;

/** Schedule the next planned arrival, if any, relative to the active time. */
const scheduleArrival = scxml`<if cond="${'next < plan.length'}">
	<script>wait = Math.max(0, plan[next].atMs - (activeMs + (Date.now() - segmentStart)));</script>
	<send event="${SCENARIO_EVENTS.arrival}" id="arrival" delayexpr="${"wait + 'ms'"}"/>
</if>`;

const ok = reply("'ok'", SCENARIO_REPLIES.ok);

export const scenarioChart = chart({
	name: SCENARIO_FAMILY,
	initial: 'live',
	data: DEFAULTS as unknown as Record<string, unknown>,
	body: scxml`
<state id="live" initial="created">
	<transition event="${`${SCENARIO_EVENTS.start} ${SCENARIO_EVENTS.pause} ${SCENARIO_EVENTS.resume} ${SCENARIO_EVENTS.stop}`}">${reply("'ignored'", SCENARIO_REPLIES.ignored)}</transition>
	<state id="created">
		<onentry>${reportState('created', '`${plan.length} personas planned.`')}</onentry>
		<transition event="${SCENARIO_EVENTS.start}" target="running">${ok}</transition>
		<transition event="${SCENARIO_EVENTS.stop}" target="stopped">${ok}</transition>
	</state>
	<state id="running">
		<onentry>
			<script>segmentStart = Date.now(); wait = Math.max(0, durationMs - activeMs);</script>
			<send event="${SCENARIO_EVENTS.durationElapsed}" id="duration" delayexpr="${"wait + 'ms'"}"/>
			${reportState('running', '`Running; ${plan.length - next} arrivals to go.`')}
			${scheduleArrival}
		</onentry>
		<onexit>
			<cancel sendid="arrival"/>
			<cancel sendid="duration"/>
			<script>activeMs += Date.now() - segmentStart;</script>
		</onexit>
		<transition event="${SCENARIO_EVENTS.arrival}">
			<send type="${HOST_IO}" event="${SCENARIO_HOST.spawn}"><content expr="({index: next})"/></send>
			<script>next += 1;</script>
			${scheduleArrival}
		</transition>
		<transition event="${SCENARIO_EVENTS.personasDone}" cond="${'next >= plan.length'}" target="draining"/>
		<transition event="${SCENARIO_EVENTS.durationElapsed}" target="draining"/>
		<transition event="${SCENARIO_EVENTS.pause}" target="paused">${ok}</transition>
		<transition event="${SCENARIO_EVENTS.stop}" target="stopped">${ok}</transition>
	</state>
	<state id="paused">
		<onentry>${reportState('paused', '`Paused after ${Math.round(activeMs / 1000)} s of activity.`')}</onentry>
		<transition event="${SCENARIO_EVENTS.resume}" target="running">${ok}</transition>
		<transition event="${SCENARIO_EVENTS.stop}" target="stopped">${ok}</transition>
	</state>
	<state id="draining">
		<onentry>
			${reportState('draining', '`No more arrivals (${next}/${plan.length} arrived); waiting for personas to finish.`')}
			<send event="${SCENARIO_EVENTS.drainTimeout}" id="drain" delayexpr="${"drainTimeoutMs + 'ms'"}"/>
		</onentry>
		<onexit><cancel sendid="drain"/></onexit>
		<transition event="${SCENARIO_EVENTS.personasDone}" target="settling"/>
		<transition event="${SCENARIO_EVENTS.drainTimeout}" target="settling">${stopPersonas('drain timeout')}</transition>
		<transition event="${SCENARIO_EVENTS.stop}" target="stopped">${ok}</transition>
	</state>
	<state id="settling">
		<onentry>
			${reportState('settling', "'All personas done; waiting for granary to close what it should.'")}
			<send event="${SCENARIO_EVENTS.settleTimeout}" id="settle" delayexpr="${"settleTimeoutMs + 'ms'"}"/>
		</onentry>
		<onexit><cancel sendid="settle"/></onexit>
		<transition event="${SCENARIO_EVENTS.observerSettled}" target="finished"/>
		<transition event="${SCENARIO_EVENTS.settleTimeout}" target="finished"/>
		<transition event="${SCENARIO_EVENTS.stop}" target="stopped">${ok}</transition>
	</state>
</state>
<final id="finished"><onentry>${reportState('finished', "'Finished.'")}</onentry></final>
<final id="stopped">
	<onentry>
		${stopPersonas('stopped')}
		${reportState('stopped', "'Stopped by operator.'")}
	</onentry>
</final>`
});
