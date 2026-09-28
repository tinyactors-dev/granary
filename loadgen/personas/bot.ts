/**
 * `bot/<scenario>-<n>` (ADR 0071): a `[bot]` account of user type Bot that
 * floods 5–15 dependabot-style issues in quick succession.
 * Expected: every issue closed (bots are not special, ADR 0004).
 */
import { statechart } from '@tinyactors/node';
import { botBody, botTitle } from '../text';
import {
	GH_ACTIONS,
	PERSONA_EVENTS as E,
	act,
	between,
	countError,
	declareBase,
	narrate,
	recordOpened,
	source,
	timed,
	type PersonaBase
} from './common';

export const KIND = 'bot';

export interface BotData extends PersonaBase {
	floodSize: number;
}

export const botChart = () => {
	const b = statechart<BotData>({ family: KIND, revision: 'v1', name: 'flooding bot' });
	declareBase(b);
	return b
		.data('floodSize', 5)
		.initial('booting')
		.state('booting', (s) =>
			s
				.entry((a) => {
					a.script(function (this: BotData) {
						this.floodSize = between(this, 5, 15);
					});
					narrate(a, 'booting', (d) => `Bot ${d.login} registering; will open ${d.floodSize} issues.`);
					act(a, GH_ACTIONS.user, (d) => ({ login: d.login, type: 'Bot' }));
				})
				.on(E.userOk, (t) => t.target('flooding'))
				.on(E.error, (t) => t.target('sleeping').script(countError))
		)
		.state('flooding', (s) => timed(s, 200, 1500).on(E.timer, (t) => t.target('posting')))
		.state('posting', (s) =>
			s
				.entry((a) => {
					a.script(function (this: BotData) {
						const r = source(this);
						this.title = botTitle(r);
						this.body = botBody(r);
					});
					act(a, GH_ACTIONS.open, (d) => ({ title: d.title, body: d.body }));
				})
				.on(E.opened, (t) =>
					t
						.when(function (this: BotData) {
							return this.opened + 1 < this.floodSize;
						})
						.target('flooding')
						.script(recordOpened)
				)
				.on(E.opened, (t) => t.target('sleeping').script(recordOpened))
				.on(E.error, (t) => t.target('sleeping').script(countError))
		)
		.final('sleeping', (s) => s.entry((a) => narrate(a, 'sleeping', (d) => `Flood done: ${d.opened} issue(s).`)));
};
