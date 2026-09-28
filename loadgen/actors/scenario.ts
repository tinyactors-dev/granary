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
 */
import { statechart, type ActionBuilder } from '@tinyactors/node';
import { HOST_IO } from '../personas/common';

export const SCENARIO_FAMILY = 'scenario';
export const scenarioAddress = (id: string) => ({ family: SCENARIO_FAMILY, name: id });

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

const elapsed = (d: ScenarioData) => d.activeMs + (Date.now() - d.segmentStart);

function reportState(a: ActionBuilder<ScenarioData>, state: string, note: (d: ScenarioData) => string) {
	a.send(SCENARIO_HOST.state, (b) =>
		b.via(HOST_IO).data(function (this: ScenarioData) {
			return { state, note: note(this), activeMs: this.activeMs };
		})
	);
}

function scheduleArrival(a: ActionBuilder<ScenarioData>) {
	a.choose(
		function (this: ScenarioData) {
			return this.next < this.plan.length;
		},
		(then) =>
			then
				.script(function (this: ScenarioData) {
					this.wait = Math.max(0, this.plan[this.next]!.atMs - elapsed(this));
				})
				.send(SCENARIO_EVENTS.arrival, (b) =>
					b
						.after(function (this: ScenarioData) {
							return this.wait;
						})
						.id('arrival')
				)
	);
}

export const scenarioChart = () =>
	statechart<ScenarioData>({ family: SCENARIO_FAMILY, revision: 'v1', name: 'scenario coordinator' })
		.data('id', '')
		.dataExpression('plan', () => [])
		.data('next', 0)
		.data('durationMs', 60_000)
		.data('drainTimeoutMs', 60_000)
		.data('settleTimeoutMs', 60_000)
		.data('activeMs', 0)
		.data('segmentStart', 0)
		.data('wait', 0)
		.data('note', '')
		.initial('created')
		.state('created', (s) =>
			s
				.entry((a) => reportState(a, 'created', (d) => `${d.plan.length} personas planned.`))
				.on(SCENARIO_EVENTS.start, (t) => t.target('running'))
				.on(SCENARIO_EVENTS.stop, (t) => t.target('stopped'))
		)
		.state('running', (s) =>
			s
				.entry((a) => {
					a.script(function (this: ScenarioData) {
						this.segmentStart = Date.now();
						this.wait = Math.max(0, this.durationMs - this.activeMs);
					});
					a.send(SCENARIO_EVENTS.durationElapsed, (b) =>
						b
							.after(function (this: ScenarioData) {
								return this.wait;
							})
							.id('duration')
					);
					reportState(a, 'running', (d) => `Running; ${d.plan.length - d.next} arrivals to go.`);
					scheduleArrival(a);
				})
				.exit((a) =>
					a
						.cancel('arrival')
						.cancel('duration')
						.script(function (this: ScenarioData) {
							this.activeMs += Date.now() - this.segmentStart;
						})
				)
				.on(SCENARIO_EVENTS.arrival, (t) => {
					t.send(SCENARIO_HOST.spawn, (b) =>
						b.via(HOST_IO).data(function (this: ScenarioData) {
							return { index: this.next };
						})
					).script(function (this: ScenarioData) {
						this.next += 1;
					});
					scheduleArrival(t as unknown as ActionBuilder<ScenarioData>);
				})
				.on(SCENARIO_EVENTS.personasDone, (t) =>
					t.when(function (this: ScenarioData) {
						return this.next >= this.plan.length;
					}).target('draining')
				)
				.on(SCENARIO_EVENTS.durationElapsed, (t) => t.target('draining'))
				.on(SCENARIO_EVENTS.pause, (t) => t.target('paused'))
				.on(SCENARIO_EVENTS.stop, (t) => t.target('stopped'))
		)
		.state('paused', (s) =>
			s
				.entry((a) => reportState(a, 'paused', (d) => `Paused after ${Math.round(d.activeMs / 1000)} s of activity.`))
				.on(SCENARIO_EVENTS.resume, (t) => t.target('running'))
				.on(SCENARIO_EVENTS.stop, (t) => t.target('stopped'))
		)
		.state('draining', (s) =>
			s
				.entry((a) => {
					reportState(a, 'draining', (d) => `No more arrivals (${d.next}/${d.plan.length} arrived); waiting for personas to finish.`);
					a.send(SCENARIO_EVENTS.drainTimeout, (b) =>
						b
							.after(function (this: ScenarioData) {
								return this.drainTimeoutMs;
							})
							.id('drain')
					);
				})
				.exit((a) => a.cancel('drain'))
				.on(SCENARIO_EVENTS.personasDone, (t) => t.target('settling'))
				.on(SCENARIO_EVENTS.drainTimeout, (t) =>
					t
						.send(SCENARIO_HOST.stopPersonas, (b) => b.via(HOST_IO).data({ reason: 'drain timeout' }))
						.target('settling')
				)
				.on(SCENARIO_EVENTS.stop, (t) => t.target('stopped'))
		)
		.state('settling', (s) =>
			s
				.entry((a) => {
					reportState(a, 'settling', () => 'All personas done; waiting for granary to close what it should.');
					a.send(SCENARIO_EVENTS.settleTimeout, (b) =>
						b
							.after(function (this: ScenarioData) {
								return this.settleTimeoutMs;
							})
							.id('settle')
					);
				})
				.exit((a) => a.cancel('settle'))
				.on(SCENARIO_EVENTS.observerSettled, (t) => t.target('finished'))
				.on(SCENARIO_EVENTS.settleTimeout, (t) => t.target('finished'))
				.on(SCENARIO_EVENTS.stop, (t) => t.target('stopped'))
		)
		.final('finished', (s) => s.entry((a) => reportState(a, 'finished', () => 'Finished.')))
		.final('stopped', (s) =>
			s.entry((a) => {
				a.send(SCENARIO_HOST.stopPersonas, (b) => b.via(HOST_IO).data({ reason: 'stopped' }));
				reportState(a, 'stopped', () => 'Stopped by operator.');
			})
		);
