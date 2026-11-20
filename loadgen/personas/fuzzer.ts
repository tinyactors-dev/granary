/**
 * `fuzzer/<scenario>-<n>` (ADR 0074): works through 8–12 seeded edge cases —
 * odd issues judged by the oracle, open/reopen races, and signed raw
 * webhook bodies that granary must answer < 500 — then is exhausted. The
 * host draws the cases (`loadgen/fuzz-cases.ts`) from the persona's seed.
 */
import { scxml } from '../../src/lib/charts';
import type { FuzzCase } from '../fuzz-cases';
import { COUNT_ERROR, GH_ACTIONS, PERSONA_EVENTS as E, TAKE_RNG, act, draft, narrate, personaChart, timed, type PersonaBase } from './common';

export const KIND = 'fuzzer';

export interface FuzzerData extends PersonaBase {
	cases: FuzzCase[];
	index: number;
	lastOutcome: string;
}

export const fuzzerChart = personaChart<FuzzerData>({
	kind: KIND,
	initial: 'preparing',
	data: { cases: [], index: 0, lastOutcome: '' },
	body: scxml`
<state id="preparing">
	<onentry>${draft('fuzz-cases', 'allowlisted: allowlisted, login: login')}</onentry>
	<transition event="${E.drafted}" target="choosing">
		${TAKE_RNG}
		<assign location="cases" expr="_event.data.cases"/>
		${narrate('preparing', "`Loaded ${cases.length} cases: ${cases.map((c) => c.name).join(', ')}.`")}
	</transition>
</state>
<state id="choosing">
	<transition cond="${'index < cases.length'}" target="executing"/>
	<transition target="exhausted"/>
</state>
<state id="executing">
	<onentry>
		${narrate('executing', '`Case ${index + 1}/${cases.length}: ${cases[index].type} ${cases[index].name}`')}
		${act(GH_ACTIONS.fuzz, '{case: cases[index]}')}
	</onentry>
	<transition event="${E.fuzzDone}" target="cooling">
		<assign location="lastOutcome" expr="_event.data.outcome"/>
		<script>index += 1;</script>
	</transition>
	<transition event="${E.error}" target="cooling">
		${COUNT_ERROR}
		<assign location="lastOutcome" expr="${'`error: ${_event.data.message}`'}"/>
		<script>index += 1;</script>
	</transition>
</state>
<state id="cooling">
	${timed(200, 1500)}
	<onentry>${narrate('cooling', 'lastOutcome')}</onentry>
	<transition event="${E.timer}" target="choosing"/>
</state>`,
	finals: {
		exhausted: '`Exhausted ${cases.length} case(s).`'
	}
});
