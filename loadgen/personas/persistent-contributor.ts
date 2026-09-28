/**
 * `persistent-contributor/<scenario>-<n>` (ADR 0071): keeps opening the same
 * request. When granary closes it they stew, then either reopen it
 * themselves or open a near-duplicate; each closure escalates their tone.
 * After 2–4 closures they rage-quit with a parting comment. If an issue
 * survives their patience window they are content.
 * Expected: every new issue is closed; their reopens stay open (ADR 0004).
 */
import { statechart } from '@tinyactors/node';
import { persistentBody, persistentTitle, rageQuit, toneName } from '../text';
import {
	GH_ACTIONS,
	PERSONA_EVENTS as E,
	act,
	between,
	countError,
	countNotification,
	declareBase,
	narrate,
	recordOpened,
	rnd,
	source,
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

const closedAgain = function (this: PersistentContributorData) {
	this.closures += 1;
	this.tone += 1;
};

export const persistentContributorChart = () => {
	const b = statechart<PersistentContributorData>({ family: KIND, revision: 'v1', name: 'persistent annoying contributor' });
	declareBase(b);
	return b
		.data('tone', 0)
		.data('closures', 0)
		.data('maxClosures', 3)
		.data('attempts', 0)
		.data('plan', 'duplicate')
		.initial('arriving')
		.state('arriving', (s) =>
			timed(s, 500, 5000)
				.entry((a) => {
					a.script(function (this: PersistentContributorData) {
						this.maxClosures = between(this, 2, 4);
					});
					narrate(a, 'arriving', (d) => `Has a feature request and will not take no for an answer (gives up after ${d.maxClosures} closures).`);
				})
				.on(E.timer, (t) => t.target('drafting'))
		)
		.state('drafting', (s) =>
			timed(s, 1000, 5000)
				.entry((a) => {
					a.script(function (this: PersistentContributorData) {
						const r = source(this);
						this.attempts += 1;
						this.title = persistentTitle(r, this.tone, this.attempts, this.title);
						this.body = persistentBody(r, this.tone);
					});
					narrate(a, 'drafting', (d) => `Writing issue #${d.attempts} in a ${toneName(d.tone)} tone: "${d.title}"`);
				})
				.on(E.timer, (t) => t.target('opening'))
		)
		.state('opening', (s) =>
			s
				.entry((a) => act(a, GH_ACTIONS.open, (d) => ({ title: d.title, body: d.body })))
				.on(E.opened, (t) => t.target('waiting').script(recordOpened))
				.on(E.error, (t) => t.target('gaveUp').script(countError))
		)
		.state('waiting', (s) =>
			timed(s, 15000, 40000)
				.entry((a) => narrate(a, 'waiting', (d) => `Waiting for a maintainer to respond on #${d.current}…`))
				.on(E.notifyComment, (t) => t.script(countNotification))
				.on(E.notifyClosed, (t) =>
					t
						.when(function (this: PersistentContributorData) {
							return this.closures + 1 >= this.maxClosures;
						})
						.target('ragequitting')
						.script(countNotification)
						.script(closedAgain)
				)
				.on(E.notifyClosed, (t) => t.target('stewing').script(countNotification).script(closedAgain))
				.on(E.timer, (t) => t.target('content'))
		)
		.state('stewing', (s) =>
			timed(s, 2000, 8000)
				.entry((a) => {
					a.script(function (this: PersistentContributorData) {
						this.plan = rnd(this) < 0.5 ? 'reopen' : 'duplicate';
					});
					narrate(
						a,
						'stewing',
						(d) => `Closed again (${d.closures}×). Now ${toneName(d.tone)}; will ${d.plan === 'reopen' ? 'reopen it' : 'open a near-duplicate'}.`
					);
				})
				.on(E.timer, (t) =>
					t.when(function (this: PersistentContributorData) {
						return this.plan === 'reopen';
					}).target('reopening')
				)
				.on(E.timer, (t) => t.target('drafting'))
		)
		.state('reopening', (s) =>
			s
				.entry((a) => act(a, GH_ACTIONS.reopen, (d) => ({ number: d.current })))
				.on(E.reopened, (t) => t.target('waitingAfterReopen'))
				.on(E.error, (t) => t.target('drafting').script(countError))
		)
		.state('waitingAfterReopen', (s) =>
			timed(s, 10000, 30000)
				.entry((a) => narrate(a, 'waitingAfterReopen', (d) => `Reopened #${d.current} themselves. Watching it like a hawk.`))
				.on(E.notifyComment, (t) => t.script(countNotification))
				.on(E.notifyClosed, (t) =>
					t
						.when(function (this: PersistentContributorData) {
							return this.closures + 1 >= this.maxClosures;
						})
						.target('ragequitting')
						.script(countNotification)
						.script(closedAgain)
				)
				.on(E.notifyClosed, (t) => t.target('stewing').script(countNotification).script(closedAgain))
				.on(E.timer, (t) =>
					t.when(function (this: PersistentContributorData) {
						return this.tone >= 2 && this.attempts < 6;
					}).target('drafting')
				)
				.on(E.timer, (t) => t.target('content'))
		)
		.state('ragequitting', (s) =>
			s
				.entry((a) => {
					a.script(function (this: PersistentContributorData) {
						this.body = rageQuit(source(this));
					});
					narrate(a, 'ragequitting', (d) => `Closed ${d.closures} times. Leaving a parting comment on #${d.current}.`);
					act(a, GH_ACTIONS.comment, (d) => ({ number: d.current, body: d.body }));
				})
				.on(E.commented, (t) => t.target('gaveUp'))
				.on(E.error, (t) => t.target('gaveUp').script(countError))
		)
		.final('content', (s) =>
			s.entry((a) => narrate(a, 'content', (d) => `Content: #${d.current} is still open. (${d.closures} closure(s) along the way.)`))
		)
		.final('gaveUp', (s) =>
			s.entry((a) => narrate(a, 'gaveUp', (d) => `Gave up after ${d.closures} closure(s) and ${d.attempts} issue(s).`))
		);
};
