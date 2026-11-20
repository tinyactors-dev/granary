/**
 * The chart shape shared by trusted personas — `regular`, `maintainer`,
 * `member` (ADR 0071). Not an actor itself: each persona file calls
 * `trustedChart` with its own kind, texts and narration.
 *
 * arriving → drafting → opening → watching → (commenting) → drafting … → done;
 * a closure while watching → wronglyClosed (granary broke its promise).
 */
import { lit, scxml } from '../../src/lib/charts';
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

export interface TrustedData extends PersonaBase {
	planned: number;
	next: 'comment' | 'draft' | 'done';
	commented: number;
	closedBy: string | null;
	unexpectedComments: number;
}

export interface TrustedOptions {
	kind: 'regular' | 'maintainer' | 'member';
	/** Which texts the host writes (`loadgen/text.ts`). */
	texts: 'regular' | 'maintainer';
	who: string;
}

/** After watching: comment (half the time, while some issue has no follow-up), draft another, or be done. Returns [next, rng]. */
function decideNext(rng: number, commented: number, opened: number, planned: number): [string, number] {
	if (commented < opened) {
		const [yes, s] = chance(rng, 0.5);
		if (yes) return ['comment', s];
		rng = s;
	}
	return [opened < planned ? 'draft' : 'done', rng];
}
declare function chance(state: number, p: number): [boolean, number];

export const trustedChart = (o: TrustedOptions) =>
	personaChart<TrustedData>({
		kind: o.kind,
		initial: 'arriving',
		data: { planned: 1, next: 'done', commented: 0, closedBy: null, unexpectedComments: 0 },
		helpers: { decideNext },
		body: scxml`
<state id="arriving">
	${timed(1000, 5000)}
	<onentry>
		<script>[planned, rng] = between(rng, 1, 3);</script>
		${narrate('arriving', `${lit(o.who)} + \` (\${login}, \${association}) plans \${planned} issue(s).\``)}
	</onentry>
	<transition event="${E.timer}" target="drafting"/>
</state>
<state id="drafting">
	${timed(2000, 6000)}
	<onentry>${draft(o.texts)}</onentry>
	<transition event="${E.drafted}">
		${TAKE_RNG}
		<assign location="title" expr="_event.data.title"/>
		<assign location="body" expr="_event.data.body"/>
		${narrate('drafting', '`Writing: "${title}"`')}
	</transition>
	<transition event="${E.timer}" target="opening"/>
</state>
<state id="opening">
	<onentry>${act(GH_ACTIONS.open, '{title: title, body: body, association: association}')}</onentry>
	<transition event="${E.opened}" target="watching">${RECORD_OPENED}</transition>
	<transition event="${E.error}" target="done">${COUNT_ERROR}</transition>
</state>
<state id="watching">
	${timed(5000, 15000)}
	<onentry>${narrate('watching', '`Opened #${current}; expects it to stay open.`')}</onentry>
	<transition event="${E.notifyClosed}" target="wronglyClosed">
		${COUNT_NOTIFICATION}
		<assign location="closedBy" expr="_event.data.by"/>
	</transition>
	<transition event="${E.notifyComment}">
		${COUNT_NOTIFICATION}
		<if cond="_event.data.byGranary"><script>unexpectedComments += 1;</script></if>
	</transition>
	<transition event="${E.timer}" target="deciding">
		<script>[next, rng] = decideNext(rng, commented, opened, planned);</script>
	</transition>
</state>
<state id="deciding">
	<transition cond="${"next === 'comment'"}" target="commenting"/>
	<transition cond="${"next === 'draft'"}" target="drafting"/>
	<transition target="done"/>
</state>
<state id="commenting">
	<onentry>${draft('follow-up')}</onentry>
	<transition event="${E.drafted}">
		${TAKE_RNG}
		<assign location="body" expr="_event.data.body"/>
		${narrate('commenting', '`Adding a follow-up on #${current}.`')}
		${act(GH_ACTIONS.comment, '{number: current, body: body}')}
	</transition>
	<transition event="${E.commented}" target="watching"><script>commented += 1;</script></transition>
	<transition event="${E.error}" target="watching">${COUNT_ERROR}</transition>
</state>`,
		finals: {
			wronglyClosed: '`WRONGLY CLOSED: #${current} was closed by ${closedBy}.`',
			done: '`Done: ${opened} issue(s), all still open.`'
		}
	});
