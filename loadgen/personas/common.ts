/**
 * Shared persona mechanics (ADR 0071) — not an actor.
 *
 * - randomness lives in the data model (`rng`, mulberry32), so a scenario
 *   seed reproduces every choice;
 * - think-times are `min..max` ms × `timeScale`, via one delayed `timer`
 *   send per state (cancelled on exit);
 * - personas act through the `github` I/O processor and explain themselves
 *   through the `host` processor (`narrate`).
 */
import type { ActionBuilder, DefinitionBuilder, StateBuilder } from '@tinyactors/node';
import type { PersonaKind } from '../schemas';
import { step, type RandomSource } from '../rng';

export const GITHUB_IO = 'github';
export const HOST_IO = 'host';
export const TIMER = 'timer';

/** Events personas receive (ADR 0071). */
export const PERSONA_EVENTS = {
	timer: TIMER,
	opened: 'gh.opened',
	reopened: 'gh.reopened',
	commented: 'gh.commented',
	userOk: 'gh.user.ok',
	chaosDone: 'gh.chaos.done',
	fuzzDone: 'gh.fuzz.done',
	error: 'gh.error',
	notifyClosed: 'notify.closed',
	notifyComment: 'notify.comment',
	notifyReopened: 'notify.reopened'
} as const;

/** Actions personas send to the `github` I/O processor. */
export const GH_ACTIONS = {
	user: 'gh.user',
	open: 'gh.open',
	reopen: 'gh.reopen',
	comment: 'gh.comment',
	chaos: 'gh.chaos',
	fuzz: 'gh.fuzz'
} as const;

export interface PersonaBase {
	id: string;
	kind: PersonaKind;
	scenarioId: string;
	login: string;
	association: string;
	/** mulberry32 state. */
	rng: number;
	timeScale: number;
	/** The current state's think-time (ms). */
	wait: number;
	/** Numbers of the issues this persona opened. */
	issues: number[];
	/** The issue it is currently about. */
	current: number | null;
	title: string | null;
	body: string | null;
	opened: number;
	notifications: number;
	errors: number;
	/** Logins granary allows (for kinds that need them). */
	allowlisted: string[];
}

/** What the engine binds when it spawns a persona. */
export type PersonaBinding = Pick<
	PersonaBase,
	'id' | 'kind' | 'scenarioId' | 'login' | 'association' | 'rng' | 'timeScale' | 'allowlisted'
>;

/** `.data(...)` declarations for every base field (defaults; the binding overrides). */
export function declareBase<D extends PersonaBase>(builder: DefinitionBuilder<D>): void {
	const b = builder as unknown as DefinitionBuilder<PersonaBase>;
	b.data('id', '')
		.data('kind', 'regular')
		.data('scenarioId', '')
		.data('login', '')
		.data('association', 'NONE')
		.data('rng', 1)
		.data('timeScale', 1)
		.data('wait', 0)
		.dataExpression('issues', () => [])
		.data('current', null)
		.data('title', null)
		.data('body', null)
		.data('opened', 0)
		.data('notifications', 0)
		.data('errors', 0)
		.dataExpression('allowlisted', () => []);
}

// ---------------------------------------------------------------------------
// Randomness (mutates d.rng)
// ---------------------------------------------------------------------------

export function rnd(d: { rng: number }): number {
	const [v, s] = step(d.rng);
	d.rng = s;
	return v;
}
export const source = (d: { rng: number }): RandomSource => ({ float: () => rnd(d) });
export const between = (d: { rng: number }, min: number, max: number) => min + Math.floor(rnd(d) * (max - min + 1));
export const chance = (d: { rng: number }, p: number) => rnd(d) < p;
export const pickOf = <T>(d: { rng: number }, xs: readonly T[]): T => xs[Math.floor(rnd(d) * xs.length)]!;
export const scaled = (d: { rng: number; timeScale: number }, minMs: number, maxMs: number) =>
	Math.max(5, Math.round((minMs + rnd(d) * (maxMs - minMs)) * d.timeScale));

// ---------------------------------------------------------------------------
// Action helpers
// ---------------------------------------------------------------------------

/** Tell the host what this persona is doing and why (timeline narration). */
export function narrate<D extends PersonaBase>(a: ActionBuilder<D>, state: string, text: (d: D) => string): void {
	a.send('narrate', (b) =>
		b.via(HOST_IO).data(function (this: D) {
			return { state, note: text(this) };
		})
	);
}

/** Ask the `github` I/O processor to do something on the fake GitHub. */
export function act<D extends PersonaBase>(a: ActionBuilder<D>, action: string, data: (d: D) => unknown): void {
	a.send(action, (b) =>
		b.via(GITHUB_IO).data(function (this: D) {
			return data(this);
		})
	);
}

/**
 * Make `s` a timed state: on entry wait `minMs..maxMs` × timeScale, then
 * raise `timer`; the timer is cancelled on exit.
 */
export function timed<D extends PersonaBase>(s: StateBuilder<D>, minMs: number, maxMs: number): StateBuilder<D> {
	return s
		.entry((a) =>
			a
				.script(function (this: D) {
					this.wait = scaled(this, minMs, maxMs);
				})
				.send(TIMER, (b) =>
					b
						.after(function (this: D) {
							return this.wait;
						})
						.id(TIMER)
				)
		)
		.exit((a) => a.cancel(TIMER));
}

/** Event data of the current event. */
export const ev = <T>(ctx: { event?: { data: unknown } }): T => ctx.event?.data as T;

export interface OpenedData {
	number: number;
	htmlUrl: string;
	issueKey: string;
}
export interface NotifyClosedData {
	number: number;
	by: string;
	byGranary: boolean;
	stateReason: string | null;
}
export interface NotifyCommentData {
	number: number;
	by: string;
	byGranary: boolean;
	body: string;
}

/** Record `gh.opened` into the base fields. */
export function recordOpened<D extends PersonaBase>(this: D, ctx: { event?: { data: unknown } }): void {
	const o = ev<OpenedData>(ctx);
	this.current = o.number;
	this.issues.push(o.number);
	this.opened += 1;
}

export function countNotification<D extends PersonaBase>(this: D): void {
	this.notifications += 1;
}

export function countError<D extends PersonaBase>(this: D): void {
	this.errors += 1;
}
