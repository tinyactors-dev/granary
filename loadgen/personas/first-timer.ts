/**
 * `first-timer/<scenario>-<n>` (ADR 0071): association
 * FIRST_TIME_CONTRIBUTOR. Opens one polite issue, reads granary's comment,
 * replies politely once after the closure, waits a while and moves on.
 * Expected: closed.
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

export const KIND = 'first-timer';

export interface FirstTimerData extends PersonaBase {
	readBotComment: boolean;
	closedBy: string | null;
}

export const firstTimerChart = personaChart<FirstTimerData>({
	kind: KIND,
	initial: 'arriving',
	data: { readBotComment: false, closedBy: null },
	body: scxml`
<state id="arriving">
	${timed(1000, 6000)}
	<onentry>${narrate('arriving', "'Nervously opening their very first GitHub issue.'")}</onentry>
	<transition event="${E.timer}" target="drafting"/>
</state>
<state id="drafting">
	${timed(3000, 10000)}
	<onentry>${draft('first-timer')}</onentry>
	<transition event="${E.drafted}">
		${TAKE_RNG}
		<assign location="title" expr="_event.data.title"/>
		<assign location="body" expr="_event.data.body"/>
		${narrate('drafting', '`Carefully writing "${title}".`')}
	</transition>
	<transition event="${E.timer}" target="opening"/>
</state>
<state id="opening">
	<onentry>${act(GH_ACTIONS.open, "{title: title, body: body, association: 'FIRST_TIME_CONTRIBUTOR'}")}</onentry>
	<transition event="${E.opened}" target="hopeful">${RECORD_OPENED}</transition>
	<transition event="${E.error}" target="movedOn">${COUNT_ERROR}</transition>
</state>
<state id="hopeful">
	${timed(20000, 60000)}
	<onentry>${narrate('hopeful', '`Hoping someone answers #${current}.`')}</onentry>
	<transition event="${E.notifyComment}">
		${COUNT_NOTIFICATION}
		<if cond="_event.data.byGranary"><assign location="readBotComment" expr="true"/></if>
	</transition>
	<transition event="${E.notifyClosed}" target="replying">
		${COUNT_NOTIFICATION}
		<assign location="closedBy" expr="_event.data.by"/>
	</transition>
	<transition event="${E.timer}" target="movedOn"/>
</state>
<state id="replying">
	${timed(2000, 6000)}
	<onentry>
		${narrate(
			'replying',
			"readBotComment ? `Read the bot's explanation on #${current}; writing a polite reply.` : `#${current} was closed; writing a polite reply.`"
		)}
	</onentry>
	<transition event="${E.timer}" target="sendingReply"/>
</state>
<state id="sendingReply">
	<onentry>${draft('polite-reply')}</onentry>
	<transition event="${E.drafted}">
		${TAKE_RNG}
		<assign location="body" expr="_event.data.body"/>
		${act(GH_ACTIONS.comment, '{number: current, body: body}')}
	</transition>
	<transition event="${E.commented}" target="waitingPatiently"/>
	<transition event="${E.error}" target="movedOn">${COUNT_ERROR}</transition>
</state>
<state id="waitingPatiently">
	${timed(10000, 30000)}
	<onentry>${narrate('waitingPatiently', "'Replied once. Waiting patiently; will not reopen.'")}</onentry>
	<transition event="${E.notifyComment}">${COUNT_NOTIFICATION}</transition>
	<transition event="${E.timer}" target="movedOn"/>
</state>`,
	finals: {
		movedOn: "'Moved on.'"
	}
});
