/**
 * `fuzzer/<scenario>-<n>` (ADR 0074): works through 8–12 seeded edge cases —
 * odd issues judged by the oracle, open/reopen races, and signed raw
 * webhook bodies that granary must answer < 500 — then is exhausted.
 */
import { statechart } from '@tinyactors/node';
import { Rng } from '../rng';
import { fuzzCases, type FuzzCase } from '../fuzz-cases';
import {
	GH_ACTIONS,
	PERSONA_EVENTS as E,
	act,
	between,
	countError,
	declareBase,
	ev,
	narrate,
	rnd,
	timed,
	type PersonaBase
} from './common';

export const KIND = 'fuzzer';

export interface FuzzerData extends PersonaBase {
	cases: FuzzCase[];
	index: number;
	lastOutcome: string;
}

export const fuzzerChart = () => {
	const b = statechart<FuzzerData>({ family: KIND, revision: 'v1', name: 'fuzzer' });
	declareBase(b);
	return b
		.dataExpression('cases', () => [])
		.data('index', 0)
		.data('lastOutcome', '')
		.initial('preparing')
		.state('preparing', (s) =>
			s
				.entry((a) => {
					a.script(function (this: FuzzerData) {
						const all = fuzzCases({ allowlisted: this.allowlisted, loginPrefix: this.login });
						const shuffled = new Rng(Math.floor(rnd(this) * 4294967296)).shuffle(all);
						this.cases = shuffled.slice(0, Math.min(all.length, between(this, 8, 12)));
					});
					narrate(a, 'preparing', (d) => `Loaded ${d.cases.length} cases: ${d.cases.map((c) => c.name).join(', ')}.`);
				})
				.always((t) => t.target('choosing'))
		)
		.state('choosing', (s) =>
			s
				.always((t) =>
					t.when(function (this: FuzzerData) {
						return this.index < this.cases.length;
					}).target('executing')
				)
				.always((t) => t.target('exhausted'))
		)
		.state('executing', (s) =>
			s
				.entry((a) => {
					narrate(a, 'executing', (d) => `Case ${d.index + 1}/${d.cases.length}: ${d.cases[d.index]!.type} ${d.cases[d.index]!.name}`);
					act(a, GH_ACTIONS.fuzz, (d) => ({ case: d.cases[d.index] }));
				})
				.on(E.fuzzDone, (t) =>
					t
						.script(function (this: FuzzerData, ctx) {
							this.lastOutcome = ev<{ outcome: string }>(ctx).outcome;
							this.index += 1;
						})
						.target('cooling')
				)
				.on(E.error, (t) =>
					t
						.script(countError)
						.script(function (this: FuzzerData, ctx) {
							this.lastOutcome = `error: ${ev<{ message: string }>(ctx).message}`;
							this.index += 1;
						})
						.target('cooling')
				)
		)
		.state('cooling', (s) =>
			timed(s, 200, 1500)
				.entry((a) => narrate(a, 'cooling', (d) => d.lastOutcome))
				.on(E.timer, (t) => t.target('choosing'))
		)
		.final('exhausted', (s) => s.entry((a) => narrate(a, 'exhausted', (d) => `Exhausted ${d.cases.length} case(s).`)));
};
