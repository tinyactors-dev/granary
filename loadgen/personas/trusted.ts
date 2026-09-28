/**
 * The chart shape shared by trusted personas — `regular`, `maintainer`,
 * `member` (ADR 0071). Not an actor itself: each persona file calls
 * `trustedChart` with its own family, texts and narration.
 *
 * arriving → drafting → opening → watching → (commenting) → drafting … → done;
 * a closure while watching → wronglyClosed (granary broke its promise).
 */
import { statechart } from '@tinyactors/node';
import type { RandomSource } from '../rng';
import { followUp } from '../text';
import {
	GH_ACTIONS,
	PERSONA_EVENTS as E,
	act,
	between,
	chance,
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

export interface TrustedData extends PersonaBase {
	planned: number;
	next: 'comment' | 'draft' | 'done';
	commented: number;
	closedBy: string | null;
	unexpectedComments: number;
}

export interface TrustedOptions {
	kind: 'regular' | 'maintainer' | 'member';
	name: string;
	title: (r: RandomSource) => string;
	body: (r: RandomSource) => string;
	who: string;
}

export const trustedChart = (o: TrustedOptions) => {
	const b = statechart<TrustedData>({ family: o.kind, revision: 'v1', name: o.name });
	declareBase(b);
	return b
		.data('planned', 1)
		.data('next', 'done')
		.data('commented', 0)
		.data('closedBy', null)
		.data('unexpectedComments', 0)
		.initial('arriving')
		.state('arriving', (s) =>
			timed(s, 1000, 5000)
				.entry((a) => {
					a.script(function (this: TrustedData) {
						this.planned = between(this, 1, 3);
					});
					narrate(a, 'arriving', (d) => `${o.who} (${d.login}, ${d.association}) plans ${d.planned} issue(s).`);
				})
				.on(E.timer, (t) => t.target('drafting'))
		)
		.state('drafting', (s) =>
			timed(s, 2000, 6000)
				.entry((a) => {
					a.script(function (this: TrustedData) {
						const r = source(this);
						this.title = o.title(r);
						this.body = o.body(r);
					});
					narrate(a, 'drafting', (d) => `Writing: "${d.title}"`);
				})
				.on(E.timer, (t) => t.target('opening'))
		)
		.state('opening', (s) =>
			s
				.entry((a) => act(a, GH_ACTIONS.open, (d) => ({ title: d.title, body: d.body, association: d.association })))
				.on(E.opened, (t) => t.target('watching').script(recordOpened))
				.on(E.error, (t) => t.target('done').script(countError))
		)
		.state('watching', (s) =>
			timed(s, 5000, 15000)
				.entry((a) => narrate(a, 'watching', (d) => `Opened #${d.current}; expects it to stay open.`))
				.on(E.notifyClosed, (t) =>
					t
						.target('wronglyClosed')
						.script(countNotification)
						.script(function (this: TrustedData, ctx) {
							this.closedBy = ev<NotifyClosedData>(ctx).by;
						})
				)
				.on(E.notifyComment, (t) =>
					t.script(countNotification).script(function (this: TrustedData, ctx) {
						if (ev<NotifyCommentData>(ctx).byGranary) this.unexpectedComments += 1;
					})
				)
				.on(E.timer, (t) =>
					t
						.script(function (this: TrustedData) {
							if (this.commented < this.opened && chance(this, 0.5)) this.next = 'comment';
							else this.next = this.opened < this.planned ? 'draft' : 'done';
						})
						.target('deciding')
				)
		)
		.state('deciding', (s) =>
			s
				.always((t) =>
					t.when(function (this: TrustedData) {
						return this.next === 'comment';
					}).target('commenting')
				)
				.always((t) =>
					t.when(function (this: TrustedData) {
						return this.next === 'draft';
					}).target('drafting')
				)
				.always((t) => t.target('done'))
		)
		.state('commenting', (s) =>
			s
				.entry((a) => {
					a.script(function (this: TrustedData) {
						this.body = followUp(source(this));
					});
					narrate(a, 'commenting', (d) => `Adding a follow-up on #${d.current}.`);
					act(a, GH_ACTIONS.comment, (d) => ({ number: d.current, body: d.body }));
				})
				.on(E.commented, (t) =>
					t
						.script(function (this: TrustedData) {
							this.commented += 1;
						})
						.target('watching')
				)
				.on(E.error, (t) => t.target('watching').script(countError))
		)
		.final('wronglyClosed', (s) =>
			s.entry((a) => narrate(a, 'wronglyClosed', (d) => `WRONGLY CLOSED: #${d.current} was closed by ${d.closedBy}.`))
		)
		.final('done', (s) =>
			s.entry((a) => narrate(a, 'done', (d) => `Done: ${d.opened} issue(s), all still open.`))
		);
};
