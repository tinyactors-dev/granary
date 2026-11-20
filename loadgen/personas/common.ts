/**
 * Shared persona mechanics (ADR 0071) — not an actor.
 *
 * Every persona chart is SCXML built with `personaChart` (src/lib/charts):
 *
 * - randomness lives in the data model (`rng`, mulberry32), so a scenario
 *   seed reproduces every choice. The chart helpers (`rnd`, `between`,
 *   `chance`, `pickOf`, `scaled`) take the RNG state and return
 *   `[value, nextState]`, which a script destructures back into `rng`;
 * - think-times are `min..max` ms × `timeScale`, via one delayed `timer`
 *   send per state (cancelled on exit), see `timed`;
 * - personas act through the `github` I/O processor, explain themselves
 *   through the `host` processor (`narrate`) and get their texts from it
 *   (`draft`, answered with `drafted`: the text generators stay in
 *   TypeScript, `loadgen/text.ts`);
 * - each final state reports the persona's id, its name and a snapshot of
 *   every variable through `<donedata>` (the host's `onDone`).
 */
import type { Source } from '@tinyactors/node';
import { chart, lit, scxml, type Raw } from '../../src/lib/charts';
import type { PersonaKind } from '../schemas';

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
	notifyReopened: 'notify.reopened',
	/** The `host` processor's answer to `draft`: `{rng, title?, body?, cases?}`. */
	drafted: 'drafted'
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

/** Requests personas send to the `host` I/O processor. */
export const HOST_REQUESTS = { narrate: 'narrate', draft: 'draft' } as const;

/** What a `draft` asks the host to write (`loadgen/text.ts`). */
export type DraftKind =
	| 'slop'
	| 'persistent'
	| 'rage-quit'
	| 'regular'
	| 'maintainer'
	| 'follow-up'
	| 'first-timer'
	| 'polite-reply'
	| 'bot'
	| 'fuzz-cases';

/** The data of a `draft` request. */
export interface DraftRequest {
	what: DraftKind;
	rng: number;
	/** `persistent`: tone, attempt and the previous title. */
	tone?: number;
	attempts?: number;
	previous?: string | null;
	/** `fuzz-cases`. */
	allowlisted?: string[];
	login?: string;
}

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

/** What the engine gives as spawn params when it spawns a persona. */
export type PersonaBinding = Pick<
	PersonaBase,
	'id' | 'kind' | 'scenarioId' | 'login' | 'association' | 'rng' | 'timeScale' | 'allowlisted'
>;

/** The `<data>` of every persona (defaults; the spawn params override them). */
const BASE_DATA: PersonaBase = {
	id: '',
	kind: 'regular',
	scenarioId: '',
	login: '',
	association: 'NONE',
	rng: 1,
	timeScale: 1,
	wait: 0,
	issues: [],
	current: null,
	title: null,
	body: null,
	opened: 0,
	notifications: 0,
	errors: 0,
	allowlisted: []
};

/** A persona's donedata: who it is, the final state it reached, and every variable. */
export interface PersonaDone {
	persona: string;
	final: string;
	data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Randomness: chart helpers. Each takes the mulberry32 state and returns
// [value, next state]; they are embedded in the chart, so each is
// self-contained (the step is `step` of loadgen/rng.ts, inlined).
// ---------------------------------------------------------------------------

function rnd(state: number): [number, number] {
	const t = (state + 0x6d2b79f5) >>> 0;
	let r = Math.imul(t ^ (t >>> 15), t | 1);
	r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
	return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}
function between(state: number, min: number, max: number): [number, number] {
	const [v, s] = rnd(state);
	return [min + Math.floor(v * (max - min + 1)), s];
}
function chance(state: number, p: number): [boolean, number] {
	const [v, s] = rnd(state);
	return [v < p, s];
}
function pickOf(state: number, xs: unknown[]): [unknown, number] {
	const [v, s] = rnd(state);
	return [xs[Math.floor(v * xs.length)], s];
}
function scaled(state: number, timeScale: number, minMs: number, maxMs: number): [number, number] {
	const [v, s] = rnd(state);
	return [Math.max(5, Math.round((minMs + v * (maxMs - minMs)) * timeScale)), s];
}

const RANDOM_HELPERS = { rnd, between, chance, pickOf, scaled };

// ---------------------------------------------------------------------------
// SCXML fragments
// ---------------------------------------------------------------------------

/** Tell the host what this persona is doing and why (timeline narration); `note` is a JavaScript expression. */
export const narrate = (state: string, note: string): Raw =>
	scxml`<send type="${HOST_IO}" event="${HOST_REQUESTS.narrate}"><content expr="${`({state: ${lit(state)}, note: ${note}})`}"/></send>`;

/** Ask the `github` I/O processor to do something on the fake GitHub; `data` is a JavaScript expression. */
export const act = (action: string, data: string): Raw =>
	scxml`<send type="${GITHUB_IO}" event="${action}"><content expr="${`(${data})`}"/></send>`;

/** Ask the host for text (answered with `drafted`); `extra` is an object literal's fields (JavaScript). */
export const draft = (what: DraftKind, extra = ''): Raw =>
	scxml`<send type="${HOST_IO}" event="${HOST_REQUESTS.draft}"><content expr="${`({what: ${lit(what)}, rng: rng${extra ? `, ${extra}` : ''}})`}"/></send>`;

/** Take the RNG state a `drafted` answer carries. */
export const TAKE_RNG = scxml`<assign location="rng" expr="_event.data.rng"/>`;

/**
 * A timed state's handlers: on entry wait `minMs..maxMs` × timeScale, then
 * get `timer`; the timer is cancelled on exit. Put it first in the state so
 * the wait is drawn before anything else the entry draws.
 */
export const timed = (minMs: number, maxMs: number): Raw =>
	scxml`<onentry><script>[wait, rng] = scaled(rng, timeScale, ${minMs}, ${maxMs});</script><send event="${TIMER}" id="${TIMER}" delayexpr="${"wait + 'ms'"}"/></onentry><onexit><cancel sendid="${TIMER}"/></onexit>`;

/** Record `gh.opened` into the base fields. */
export const RECORD_OPENED = scxml`<script>current = _event.data.number; issues.push(current); opened += 1;</script>`;
export const COUNT_NOTIFICATION = scxml`<script>notifications += 1;</script>`;
export const COUNT_ERROR = scxml`<script>errors += 1;</script>`;

export interface PersonaChartSpec<D extends PersonaBase> {
	kind: PersonaKind;
	initial: string;
	/** The kind's own variables and their defaults (the base ones are added). */
	data: Omit<D, keyof PersonaBase>;
	/** Helpers beyond the random ones. */
	helpers?: Record<string, (...args: never[]) => unknown>;
	/** The non-final states. */
	body: Raw;
	/** The final states: id → narration (a JavaScript expression). */
	finals: Record<string, string>;
}

/** A persona chart (chart name = its kind): base data, random helpers, and finals that report through donedata. */
export function personaChart<D extends PersonaBase>(spec: PersonaChartSpec<D>): Source {
	const data: Record<string, unknown> = { ...BASE_DATA, kind: spec.kind, ...spec.data };
	const snapshot = `{${Object.keys(data)
		.map((k) => `${k}: ${k}`)
		.join(', ')}}`;
	const finals = Object.entries(spec.finals).map(
		([id, note]) =>
			scxml`<final id="${id}"><onentry>${narrate(id, note)}</onentry><donedata><content expr="${`({persona: id, final: ${lit(id)}, data: ${snapshot}})`}"/></donedata></final>`
	);
	return chart({
		name: spec.kind,
		initial: spec.initial,
		helpers: { ...RANDOM_HELPERS, ...(spec.helpers ?? {}) },
		data,
		body: scxml`${spec.body}
${finals}`
	});
}

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
