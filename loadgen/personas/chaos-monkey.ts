/**
 * `chaos-monkey/<scenario>-<n>` (ADR 0074): every few seconds strikes the
 * infrastructure of its scenario's repository — REST faults on granary's
 * comment/close calls, or duplicate / burst webhook redeliveries — 3–6
 * times, then retires. Fault counts stay ≤ 2 per strike so granary's relay
 * (6 attempts) always recovers.
 */
import { lit, scxml } from '../../src/lib/charts';
import { COUNT_ERROR, GH_ACTIONS, PERSONA_EVENTS as E, act, between, narrate, personaChart, rnd, timed, type PersonaBase } from './common';

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
	/** The `gh.chaos` request being made. */
	request: ChaosRequest | null;
}

/** The strike's request: count, Retry-After and the delivery pick, drawn in that order. Returns [request, rng]. */
function chaosRequest(rng: number, strike: string): [unknown, number] {
	const [count, s1] = between(rng, 1, 2);
	const [retryAfter, s2] = between(s1, 1, 2);
	const [pick, s3] = rnd(s2);
	return [{ strike, count, retryAfter, pick }, s3];
}

export const chaosMonkeyChart = personaChart<ChaosMonkeyData>({
	kind: KIND,
	initial: 'lurking',
	data: { strikes: 0, maxStrikes: 3, strike: 'comment-500', lastOutcome: '', request: null },
	helpers: { chaosRequest },
	body: scxml`
<state id="lurking">
	${timed(3000, 10000)}
	<onentry>
		<if cond="strikes === 0"><script>[maxStrikes, rng] = between(rng, 3, 6);</script></if>
		${narrate('lurking', '`Lurking (${strikes}/${maxStrikes} strikes so far).`')}
	</onentry>
	<transition event="${E.timer}" target="striking"/>
</state>
<state id="striking">
	<onentry>
		<script>${`[strike, rng] = pickOf(rng, ${lit(STRIKES)}); [request, rng] = chaosRequest(rng, strike);`}</script>
		${narrate('striking', '`Strike: ${strike}.`')}
		${act(GH_ACTIONS.chaos, 'request')}
	</onentry>
	<transition event="${E.chaosDone}" target="assessing">
		<script>strikes += 1;</script>
		<assign location="lastOutcome" expr="_event.data.outcome"/>
	</transition>
	<transition event="${E.error}" target="assessing">
		${COUNT_ERROR}
		<script>strikes += 1;</script>
		<assign location="lastOutcome" expr="${'`failed: ${_event.data.message}`'}"/>
	</transition>
</state>
<state id="assessing">
	<onentry>${narrate('assessing', '`Outcome: ${lastOutcome}`')}</onentry>
	<transition cond="${'strikes < maxStrikes'}" target="lurking"/>
	<transition target="retired"/>
</state>`,
	finals: {
		retired: '`Retired after ${strikes} strike(s).`'
	}
});
