/**
 * `slop-fixer/<scenario>-<n>` — the drive-by slop fixer (ADR 0071).
 * Opens 1–3 huge, low-effort issues (walls of buzzwords, pasted logs,
 * emoji), never reads or answers anything, then vanishes.
 * Expected: granary closes every issue.
 */
import { statechart } from '@tinyactors/node';
import { slopBody, slopTitle } from '../text';
import {
	GH_ACTIONS,
	PERSONA_EVENTS as E,
	act,
	between,
	countError,
	countNotification,
	declareBase,
	ev,
	narrate,
	recordOpened,
	source,
	timed,
	type NotifyClosedData,
	type PersonaBase
} from './common';

export const KIND = 'slop-fixer';

export interface SlopFixerData extends PersonaBase {
	/** How many issues this visit. */
	burst: number;
	ignored: number;
}

export const slopFixerChart = () => {
	const b = statechart<SlopFixerData>({ family: KIND, revision: 'v1', name: 'drive-by slop fixer' });
	declareBase(b);
	return b
		.data('burst', 1)
		.data('ignored', 0)
		.initial('arriving')
		.state('arriving', (s) =>
			timed(s, 500, 4000)
				.entry((a) => {
					a.script(function (this: SlopFixerData) {
						this.burst = between(this, 1, 3);
					});
					narrate(a, 'arriving', (d) => `Found the repo. Plans to "fix" it with ${d.burst} issue(s).`);
				})
				.on(E.timer, (t) => t.target('drafting'))
		)
		.state('drafting', (s) =>
			timed(s, 2000, 8000)
				.entry((a) => {
					a.script(function (this: SlopFixerData) {
						const r = source(this);
						this.title = slopTitle(r);
						this.body = slopBody(r);
					});
					narrate(a, 'drafting', (d) => `Pasting ${Math.round((d.body?.length ?? 0) / 1024)} KB of generated text and logs.`);
				})
				.on(E.timer, (t) => t.target('opening'))
		)
		.state('opening', (s) =>
			s
				.entry((a) => act(a, GH_ACTIONS.open, (d) => ({ title: d.title, body: d.body })))
				.on(E.opened, (t) => t.target('lurking').script(recordOpened))
				.on(E.error, (t) => t.target('vanished').script(countError))
		)
		.state('lurking', (s) =>
			timed(s, 5000, 20000)
				.entry((a) => narrate(a, 'lurking', (d) => `Opened #${d.current}. Will not read any replies.`))
				.on(E.notifyClosed, (t) =>
					t.script(countNotification).script(function (this: SlopFixerData, ctx) {
						this.ignored += 1;
						void ev<NotifyClosedData>(ctx);
					})
				)
				.on(E.notifyComment, (t) =>
					t.script(countNotification).script(function (this: SlopFixerData) {
						this.ignored += 1;
					})
				)
				.on(E.timer, (t) =>
					t.when(function (this: SlopFixerData) {
						return this.opened < this.burst;
					}).target('drafting')
				)
				.on(E.timer, (t) => t.target('vanished'))
		)
		.final('vanished', (s) =>
			s.entry((a) =>
				narrate(a, 'vanished', (d) => `Vanished. Opened ${d.opened} issue(s), ignored ${d.ignored} notification(s).`)
			)
		);
};
