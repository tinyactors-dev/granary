/**
 * `bot/<scenario>-<n>` (ADR 0071): a `[bot]` account of user type Bot that
 * floods 5–15 dependabot-style issues in quick succession.
 * Expected: every issue closed (bots are not special, ADR 0004).
 */
import { scxml } from '../../src/lib/charts';
import {
	COUNT_ERROR,
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

export const KIND = 'bot';

export interface BotData extends PersonaBase {
	floodSize: number;
}

export const botChart = personaChart<BotData>({
	kind: KIND,
	initial: 'booting',
	data: { floodSize: 5 },
	body: scxml`
<state id="booting">
	<onentry>
		<script>[floodSize, rng] = between(rng, 5, 15);</script>
		${narrate('booting', '`Bot ${login} registering; will open ${floodSize} issues.`')}
		${act(GH_ACTIONS.user, "{login: login, type: 'Bot'}")}
	</onentry>
	<transition event="${E.userOk}" target="flooding"/>
	<transition event="${E.error}" target="sleeping">${COUNT_ERROR}</transition>
</state>
<state id="flooding">
	${timed(200, 1500)}
	<transition event="${E.timer}" target="posting"/>
</state>
<state id="posting">
	<onentry>${draft('bot')}</onentry>
	<transition event="${E.drafted}">
		${TAKE_RNG}
		<assign location="title" expr="_event.data.title"/>
		<assign location="body" expr="_event.data.body"/>
		${act(GH_ACTIONS.open, '{title: title, body: body}')}
	</transition>
	<transition event="${E.opened}" cond="${'opened + 1 < floodSize'}" target="flooding">${RECORD_OPENED}</transition>
	<transition event="${E.opened}" target="sleeping">${RECORD_OPENED}</transition>
	<transition event="${E.error}" target="sleeping">${COUNT_ERROR}</transition>
</state>`,
	finals: {
		sleeping: '`Flood done: ${opened} issue(s).`'
	}
});
