/**
 * `slop-fixer/<scenario>-<n>` — the drive-by slop fixer (ADR 0071).
 * Opens 1–3 huge, low-effort issues (walls of buzzwords, pasted logs,
 * emoji), never reads or answers anything, then vanishes.
 * Expected: granary closes every issue.
 */
import { scxml } from '../../src/lib/charts';
import {
	COUNT_ERROR,
	COUNT_NOTIFICATION,
	GH_ACTIONS,
	PERSONA_EVENTS as E,
	RECORD_OPENED,
	TAKE_RNG,
	act,
	draft,
	narrate,
	personaChart,
	timed,
	type PersonaBase
} from './common';

export const KIND = 'slop-fixer';

export interface SlopFixerData extends PersonaBase {
	/** How many issues this visit. */
	burst: number;
	ignored: number;
}

export const slopFixerChart = personaChart<SlopFixerData>({
	kind: KIND,
	initial: 'arriving',
	data: { burst: 1, ignored: 0 },
	body: scxml`
<state id="arriving">
	${timed(500, 4000)}
	<onentry>
		<script>[burst, rng] = between(rng, 1, 3);</script>
		${narrate('arriving', '`Found the repo. Plans to "fix" it with ${burst} issue(s).`')}
	</onentry>
	<transition event="${E.timer}" target="drafting"/>
</state>
<state id="drafting">
	${timed(2000, 8000)}
	<onentry>${draft('slop')}</onentry>
	<transition event="${E.drafted}">
		${TAKE_RNG}
		<assign location="title" expr="_event.data.title"/>
		<assign location="body" expr="_event.data.body"/>
		${narrate('drafting', '`Pasting ${Math.round((body ? body.length : 0) / 1024)} KB of generated text and logs.`')}
	</transition>
	<transition event="${E.timer}" target="opening"/>
</state>
<state id="opening">
	<onentry>${act(GH_ACTIONS.open, '{title: title, body: body}')}</onentry>
	<transition event="${E.opened}" target="lurking">${RECORD_OPENED}</transition>
	<transition event="${E.error}" target="vanished">${COUNT_ERROR}</transition>
</state>
<state id="lurking">
	${timed(5000, 20000)}
	<onentry>${narrate('lurking', '`Opened #${current}. Will not read any replies.`')}</onentry>
	<transition event="${E.notifyClosed}">${COUNT_NOTIFICATION}<script>ignored += 1;</script></transition>
	<transition event="${E.notifyComment}">${COUNT_NOTIFICATION}<script>ignored += 1;</script></transition>
	<transition event="${E.timer}" cond="${'opened < burst'}" target="drafting"/>
	<transition event="${E.timer}" target="vanished"/>
</state>`,
	finals: {
		vanished: '`Vanished. Opened ${opened} issue(s), ignored ${ignored} notification(s).`'
	}
});
