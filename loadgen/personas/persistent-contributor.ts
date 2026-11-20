/**
 * `persistent-contributor/<scenario>-<n>` (ADR 0071): keeps opening the same
 * request. When granary closes it they stew, then either reopen it
 * themselves or open a near-duplicate; each closure escalates their tone.
 * After 2–4 closures they rage-quit with a parting comment. If an issue
 * survives their patience window they are content.
 * Expected: every new issue is closed; their reopens stay open (ADR 0004).
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

export const KIND = 'persistent-contributor';

export interface PersistentContributorData extends PersonaBase {
	/** 0 polite … 3 furious. */
	tone: number;
	closures: number;
	maxClosures: number;
	/** Issues written so far (including the current draft). */
	attempts: number;
	/** What to do after stewing. */
	plan: 'reopen' | 'duplicate';
}

/** The tone's name (`toneName` of loadgen/text.ts, inlined: a chart helper is self-contained). */
function toneName(tone: number): string {
	const tones = ['polite', 'insistent', 'annoyed', 'furious'];
	return tones[Math.min(tone, tones.length - 1)]!;
}

/** After stewing: reopen or file a near-duplicate, even odds. Returns [plan, rng]. */
function pickPlan(rng: number): [string, number] {
	const [v, s] = rnd(rng);
	return [v < 0.5 ? 'reopen' : 'duplicate', s];
}
declare function rnd(state: number): [number, number];

/** A closure while waiting: rage-quit at the last one, else stew. */
const closedWhileWaiting = scxml`
	<transition event="${E.notifyComment}">${COUNT_NOTIFICATION}</transition>
	<transition event="${E.notifyClosed}" cond="${'closures + 1 >= maxClosures'}" target="ragequitting">
		${COUNT_NOTIFICATION}<script>closures += 1; tone += 1;</script>
	</transition>
	<transition event="${E.notifyClosed}" target="stewing">
		${COUNT_NOTIFICATION}<script>closures += 1; tone += 1;</script>
	</transition>`;

export const persistentContributorChart = personaChart<PersistentContributorData>({
	kind: KIND,
	initial: 'arriving',
	data: { tone: 0, closures: 0, maxClosures: 3, attempts: 0, plan: 'duplicate' },
	helpers: { toneName, pickPlan },
	body: scxml`
<state id="arriving">
	${timed(500, 5000)}
	<onentry>
		<script>[maxClosures, rng] = between(rng, 2, 4);</script>
		${narrate('arriving', '`Has a feature request and will not take no for an answer (gives up after ${maxClosures} closures).`')}
	</onentry>
	<transition event="${E.timer}" target="drafting"/>
</state>
<state id="drafting">
	${timed(1000, 5000)}
	<onentry>
		<script>attempts += 1;</script>
		${draft('persistent', 'tone: tone, attempts: attempts, previous: title')}
	</onentry>
	<transition event="${E.drafted}">
		${TAKE_RNG}
		<assign location="title" expr="_event.data.title"/>
		<assign location="body" expr="_event.data.body"/>
		${narrate('drafting', '`Writing issue #${attempts} in a ${toneName(tone)} tone: "${title}"`')}
	</transition>
	<transition event="${E.timer}" target="opening"/>
</state>
<state id="opening">
	<onentry>${act(GH_ACTIONS.open, '{title: title, body: body}')}</onentry>
	<transition event="${E.opened}" target="waiting">${RECORD_OPENED}</transition>
	<transition event="${E.error}" target="gaveUp">${COUNT_ERROR}</transition>
</state>
<state id="waiting">
	${timed(15000, 40000)}
	<onentry>${narrate('waiting', '`Waiting for a maintainer to respond on #${current}…`')}</onentry>
	${closedWhileWaiting}
	<transition event="${E.timer}" target="content"/>
</state>
<state id="stewing">
	${timed(2000, 8000)}
	<onentry>
		<script>[plan, rng] = pickPlan(rng);</script>
		${narrate(
			'stewing',
			"`Closed again (${closures}×). Now ${toneName(tone)}; will ${plan === 'reopen' ? 'reopen it' : 'open a near-duplicate'}.`"
		)}
	</onentry>
	<transition event="${E.timer}" cond="${"plan === 'reopen'"}" target="reopening"/>
	<transition event="${E.timer}" target="drafting"/>
</state>
<state id="reopening">
	<onentry>${act(GH_ACTIONS.reopen, '{number: current}')}</onentry>
	<transition event="${E.reopened}" target="waitingAfterReopen"/>
	<transition event="${E.error}" target="drafting">${COUNT_ERROR}</transition>
</state>
<state id="waitingAfterReopen">
	${timed(10000, 30000)}
	<onentry>${narrate('waitingAfterReopen', '`Reopened #${current} themselves. Watching it like a hawk.`')}</onentry>
	${closedWhileWaiting}
	<transition event="${E.timer}" cond="${'tone >= 2 && attempts < 6'}" target="drafting"/>
	<transition event="${E.timer}" target="content"/>
</state>
<state id="ragequitting">
	<onentry>${draft('rage-quit')}</onentry>
	<transition event="${E.drafted}">
		${TAKE_RNG}
		<assign location="body" expr="_event.data.body"/>
		${narrate('ragequitting', '`Closed ${closures} times. Leaving a parting comment on #${current}.`')}
		${act(GH_ACTIONS.comment, '{number: current, body: body}')}
	</transition>
	<transition event="${E.commented}" target="gaveUp"/>
	<transition event="${E.error}" target="gaveUp">${COUNT_ERROR}</transition>
</state>`,
	finals: {
		content: '`Content: #${current} is still open. (${closures} closure(s) along the way.)`',
		gaveUp: '`Gave up after ${closures} closure(s) and ${attempts} issue(s).`'
	}
});
