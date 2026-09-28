/**
 * `chaos-monkey/<scenario>-<n>` (ADR 0074): every few seconds strikes the
 * infrastructure of its scenario's repository — REST faults on granary's
 * comment/close calls, or duplicate / burst webhook redeliveries — 3–6
 * times, then retires. Fault counts stay ≤ 2 per strike so granary's relay
 * (6 attempts) always recovers.
 */
import { statechart } from '@tinyactors/node';
import {
	GH_ACTIONS,
	PERSONA_EVENTS as E,
	act,
	between,
	countError,
	declareBase,
	ev,
	narrate,
	pickOf,
	rnd,
	timed,
	type PersonaBase
} from './common';

export const KIND = 'chaos-monkey';

export const STRIKES = ['comment-500', 'close-503', 'comment-403-retry-after', 'duplicate-delivery', 'delivery-burst'] as const;
export type Strike = (typeof STRIKES)[number];

/** Data of `gh.chaos`. */
export interface ChaosRequest {
	strike: Strike;
	count: number;
	retryAfter: number;
	/** A random float, so the host's choice of delivery is seeded too. */
	pick: number;
}

export interface ChaosMonkeyData extends PersonaBase {
	strikes: number;
	maxStrikes: number;
	strike: Strike;
	lastOutcome: string;
}

export const chaosMonkeyChart = () => {
	const b = statechart<ChaosMonkeyData>({ family: KIND, revision: 'v1', name: 'chaos monkey' });
	declareBase(b);
	return b
		.data('strikes', 0)
		.data('maxStrikes', 3)
		.data('strike', 'comment-500')
		.data('lastOutcome', '')
		.initial('lurking')
		.state('lurking', (s) =>
			timed(s, 3000, 10000)
				.entry((a) => {
					a.script(function (this: ChaosMonkeyData) {
						if (this.strikes === 0) this.maxStrikes = between(this, 3, 6);
					});
					narrate(a, 'lurking', (d) => `Lurking (${d.strikes}/${d.maxStrikes} strikes so far).`);
				})
				.on(E.timer, (t) => t.target('striking'))
		)
		.state('striking', (s) =>
			s
				.entry((a) => {
					a.script(function (this: ChaosMonkeyData) {
						this.strike = pickOf(this, STRIKES);
					});
					narrate(a, 'striking', (d) => `Strike: ${d.strike}.`);
					act(a, GH_ACTIONS.chaos, (d): ChaosRequest => ({
						strike: d.strike,
						count: between(d, 1, 2),
						retryAfter: between(d, 1, 2),
						pick: rnd(d)
					}));
				})
				.on(E.chaosDone, (t) =>
					t
						.script(function (this: ChaosMonkeyData, ctx) {
							this.strikes += 1;
							this.lastOutcome = ev<{ outcome: string }>(ctx).outcome;
						})
						.target('assessing')
				)
				.on(E.error, (t) =>
					t
						.script(countError)
						.script(function (this: ChaosMonkeyData, ctx) {
							this.strikes += 1;
							this.lastOutcome = `failed: ${ev<{ message: string }>(ctx).message}`;
						})
						.target('assessing')
				)
		)
		.state('assessing', (s) =>
			s
				.entry((a) => narrate(a, 'assessing', (d) => `Outcome: ${d.lastOutcome}`))
				.always((t) =>
					t.when(function (this: ChaosMonkeyData) {
						return this.strikes < this.maxStrikes;
					}).target('lurking')
				)
				.always((t) => t.target('retired'))
		)
		.final('retired', (s) => s.entry((a) => narrate(a, 'retired', (d) => `Retired after ${d.strikes} strike(s).`)));
};
