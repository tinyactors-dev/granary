/**
 * `first-timer/<scenario>-<n>` (ADR 0071): association
 * FIRST_TIME_CONTRIBUTOR. Opens one polite issue, reads granary's comment,
 * replies politely once after the closure, waits a while and moves on.
 * Expected: closed.
 */
import { statechart } from '@tinyactors/node';
import { firstTimerBody, firstTimerTitle, politeReply } from '../text';
import {
	GH_ACTIONS,
	PERSONA_EVENTS as E,
	act,
	countError,
	countNotification,
	declareBase,
	ev,
	narrate,
	recordOpened,
	source,
	timed,
	type NotifyClosedData,
	type NotifyCommentData,
	type PersonaBase
} from './common';

export const KIND = 'first-timer';

export interface FirstTimerData extends PersonaBase {
	readBotComment: boolean;
	closedBy: string | null;
}

export const firstTimerChart = () => {
	const b = statechart<FirstTimerData>({ family: KIND, revision: 'v1', name: 'first-timer' });
	declareBase(b);
	return b
		.data('readBotComment', false)
		.data('closedBy', null)
		.initial('arriving')
		.state('arriving', (s) =>
			timed(s, 1000, 6000)
				.entry((a) => narrate(a, 'arriving', () => 'Nervously opening their very first GitHub issue.'))
				.on(E.timer, (t) => t.target('drafting'))
		)
		.state('drafting', (s) =>
			timed(s, 3000, 10000)
				.entry((a) => {
					a.script(function (this: FirstTimerData) {
						const r = source(this);
						this.title = firstTimerTitle(r);
						this.body = firstTimerBody();
					});
					narrate(a, 'drafting', (d) => `Carefully writing "${d.title}".`);
				})
				.on(E.timer, (t) => t.target('opening'))
		)
		.state('opening', (s) =>
			s
				.entry((a) => act(a, GH_ACTIONS.open, (d) => ({ title: d.title, body: d.body, association: 'FIRST_TIME_CONTRIBUTOR' })))
				.on(E.opened, (t) => t.target('hopeful').script(recordOpened))
				.on(E.error, (t) => t.target('movedOn').script(countError))
		)
		.state('hopeful', (s) =>
			timed(s, 20000, 60000)
				.entry((a) => narrate(a, 'hopeful', (d) => `Hoping someone answers #${d.current}.`))
				.on(E.notifyComment, (t) =>
					t.script(countNotification).script(function (this: FirstTimerData, ctx) {
						if (ev<NotifyCommentData>(ctx).byGranary) this.readBotComment = true;
					})
				)
				.on(E.notifyClosed, (t) =>
					t
						.target('replying')
						.script(countNotification)
						.script(function (this: FirstTimerData, ctx) {
							this.closedBy = ev<NotifyClosedData>(ctx).by;
						})
				)
				.on(E.timer, (t) => t.target('movedOn'))
		)
		.state('replying', (s) =>
			timed(s, 2000, 6000)
				.entry((a) =>
					narrate(a, 'replying', (d) =>
						d.readBotComment ? `Read the bot's explanation on #${d.current}; writing a polite reply.` : `#${d.current} was closed; writing a polite reply.`
					)
				)
				.on(E.timer, (t) => t.target('sendingReply'))
		)
		.state('sendingReply', (s) =>
			s
				.entry((a) => {
					a.script(function (this: FirstTimerData) {
						this.body = politeReply(source(this));
					});
					act(a, GH_ACTIONS.comment, (d) => ({ number: d.current, body: d.body }));
				})
				.on(E.commented, (t) => t.target('waitingPatiently'))
				.on(E.error, (t) => t.target('movedOn').script(countError))
		)
		.state('waitingPatiently', (s) =>
			timed(s, 10000, 30000)
				.entry((a) => narrate(a, 'waitingPatiently', () => 'Replied once. Waiting patiently; will not reopen.'))
				.on(E.notifyComment, (t) => t.script(countNotification))
				.on(E.timer, (t) => t.target('movedOn'))
		)
		.final('movedOn', (s) => s.entry((a) => narrate(a, 'movedOn', () => 'Moved on.')));
};
