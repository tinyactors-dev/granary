/**
 * Trace vocabulary and predicates (ADR 0062).
 *
 * What tinyactors 0.1 emits with `detail: 'decisions', values: true`
 * (discovered empirically, see ADR 0062):
 *
 * | span name | when | key attributes |
 * |---|---|---|
 * | `scxml.spawned` | actor spawned (also by a loader) | `scxml.session_id`, `scxml.definition`, `scxml.actor` (`slot:gen`) |
 * | `scxml.macrostep bootstrap` | initial macrostep | `scxml.state` (active atomic states after it) |
 * | `scxml.macrostep <event>` | one per external event taken | `scxml.event.name`, `scxml.event.data` (JSON, cut at 256), `scxml.event.sendid`, `scxml.state` |
 * | `scxml.microstep <event>` / `scxml.microstep (eventless)` | one per microstep | `scxml.transition` (`"a → b on e"`), `scxml.state.entered`, `scxml.state.exited` |
 * | `scxml.finished` | top-level final state reached | `scxml.final_state` |
 * | `scxml.destroyed` | actor destroyed | – |
 *
 * tinyactors spans carry NO actor address. The app's tracer (ADR 0042)
 * enriches them with `granary.actor.family` / `granary.actor.name` /
 * `granary.actor.address`, and `scxml.finished` of issue actors with
 * `granary.done.verdict` / `granary.done.reason` / `granary.done.delivery_id`;
 * those win when present. Fallbacks (e.g. the fake GitHub's own spans):
 * the family from the `tinyactors.definition.registered` OTLP log that maps
 * the numeric `scxml.definition` (collected by `otlp.ts`), and the name from
 * event data — `"issueKey":"<key>"` or `"effectKey":"close:<repoId>:<number>"`.
 * Sessions are keyed by `(service, epoch, scxml.session_id)`.
 *
 * Span names (ADR 0155): the app (and ops) rename spans of known actors to
 * `<family> <kind>[ <detail>]` — e.g. `issue macrostep issue.opened` — and
 * keep the original name in `tinyactors.span.name` and the kind in
 * `tinyactors.span.kind`. Predicates therefore match on the KIND (attribute
 * first, else parsed from an unrenamed `scxml.<kind>` name, e.g. the fake
 * GitHub's spans), never on the span name.
 */
import type { CollectedSpan } from './otlp';
import { spanKindOf } from '../src/lib/trace/span-name';

export interface ActorAddress {
	family: string;
	name: string;
}

export const APP_SERVICE = 'granary';
export const FAKE_GITHUB_SERVICE = 'fake-github';

/** Issue actor states (ADR 0002). */
export const ISSUE_STATES = ['restore', 'idle', 'checking', 'closing', 'allowed', 'closed', 'failed', 'settled'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const issueAddress = (repoId: number, number: number): ActorAddress => ({
	family: 'issue',
	name: `${repoId}-${number}`
});
export const ALLOWLIST_ADDRESS: ActorAddress = { family: 'allowlist', name: 'main' };
export const formatAddress = (a: ActorAddress) => `${a.family}/${a.name}`;

// ---------------------------------------------------------------------------
// Span accessors
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export const sessionIdOf = (s: CollectedSpan) => str(s.attributes['scxml.session_id']);
export const eventNameOf = (s: CollectedSpan) => str(s.attributes['scxml.event.name']);
export const eventDataOf = (s: CollectedSpan) => str(s.attributes['scxml.event.data']);
export const finalStateOf = (s: CollectedSpan) => str(s.attributes['scxml.final_state']);
export const enteredStatesOf = (s: CollectedSpan) => strings(s.attributes['scxml.state.entered']);
export const activeStatesOf = (s: CollectedSpan) => strings(s.attributes['scxml.state']);
export const isMacrostep = (s: CollectedSpan) => spanKindOf(s) === 'macrostep';
export const isMicrostep = (s: CollectedSpan) => spanKindOf(s) === 'microstep';
export const isFinished = (s: CollectedSpan) => spanKindOf(s) === 'finished';

/** Attributes the app's tracer adds (ADR 0042). */
export const GRANARY_ATTRS = {
	family: 'granary.actor.family',
	name: 'granary.actor.name',
	address: 'granary.actor.address',
	doneVerdict: 'granary.done.verdict',
	doneReason: 'granary.done.reason',
	doneDeliveryId: 'granary.done.delivery_id'
} as const;
export const doneVerdictOf = (s: CollectedSpan) => str(s.attributes[GRANARY_ATTRS.doneVerdict]);
export const doneReasonOf = (s: CollectedSpan) => str(s.attributes[GRANARY_ATTRS.doneReason]);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** All spans of one actor session in one process generation. */
export interface ActorSession {
	key: string;
	service: string;
	epoch: number;
	sessionId: string;
	family: string | undefined;
	address: ActorAddress | undefined;
	spans: CollectedSpan[];
	/** States entered, in order (microsteps + bootstrap). */
	entered: string[];
	/** External events taken, in order. */
	events: string[];
	finalState: string | undefined;
	/** `granary.done.reason` of the finished span, when the app attached it. */
	doneReason: string | undefined;
}

const ISSUE_KEY_RE = /"issueKey"\s*:\s*"(\d+-\d+)"/;
const EFFECT_KEY_RE = /"effectKey"\s*:\s*"close:(\d+):(\d+)"/;
const ISSUE_ONLY_STATES = new Set(['restore', 'checking', 'closing', 'settled']);
const ALLOWLIST_EVENTS = new Set(['allowlist.check', 'allowlist.replace']);

/** Infer the family when no definition log was collected. */
function guessFamily(spans: CollectedSpan[], entered: string[], events: string[]): string | undefined {
	if (entered.some((s) => ISSUE_ONLY_STATES.has(s))) return 'issue';
	if (events.some((e) => ALLOWLIST_EVENTS.has(e))) return 'allowlist';
	if (spans.some((s) => ISSUE_KEY_RE.test(eventDataOf(s) ?? '') && eventNameOf(s) === 'issue.opened')) return 'issue';
	return undefined;
}

function nameFor(family: string | undefined, spans: CollectedSpan[]): string | undefined {
	if (family === 'allowlist') return 'main';
	for (const s of spans) {
		const data = eventDataOf(s);
		if (!data) continue;
		const k = ISSUE_KEY_RE.exec(data);
		if (k) return k[1];
		const e = EFFECT_KEY_RE.exec(data);
		if (e) return `${e[1]}-${e[2]}`;
	}
	return undefined;
}

/**
 * An index over collected spans: groups them into actor sessions and
 * resolves each session's family and address. Rebuilt per query (cheap at
 * test scale).
 */
export class TraceIndex {
	readonly sessions = new Map<string, ActorSession>();
	private bySpan = new Map<CollectedSpan, ActorSession>();

	constructor(
		readonly spans: readonly CollectedSpan[],
		familyOf: (span: CollectedSpan) => string | undefined = () => undefined
	) {
		const groups = new Map<string, CollectedSpan[]>();
		for (const s of spans) {
			const id = sessionIdOf(s);
			if (id === undefined) continue;
			const key = `${s.service}:${s.epoch}:${id}`;
			let g = groups.get(key);
			if (!g) groups.set(key, (g = []));
			g.push(s);
		}
		for (const [key, group] of groups) {
			group.sort((a, b) =>
				a.startTimeUnixNano === b.startTimeUnixNano ? a.seq - b.seq : a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1
			);
			const entered = group.filter(isMicrostep).flatMap(enteredStatesOf);
			const events = group.filter(isMacrostep).map(eventNameOf).filter((e): e is string => !!e);
			const first = group[0]!;
			const attr = (k: string) => group.map((s) => str(s.attributes[k])).find(Boolean);
			const family = attr(GRANARY_ATTRS.family) ?? group.map(familyOf).find(Boolean) ?? guessFamily(group, entered, events);
			const name = attr(GRANARY_ATTRS.name) ?? nameFor(family, group);
			const session: ActorSession = {
				key,
				service: first.service,
				epoch: first.epoch,
				sessionId: sessionIdOf(first)!,
				family,
				address: family && name ? { family, name } : undefined,
				spans: group,
				entered,
				events,
				finalState: group.filter(isFinished).map(finalStateOf).find(Boolean),
				doneReason: group.filter(isFinished).map(doneReasonOf).find(Boolean)
			};
			this.sessions.set(key, session);
			for (const s of group) this.bySpan.set(s, session);
		}
	}

	sessionOf(span: CollectedSpan): ActorSession | undefined {
		return this.bySpan.get(span);
	}

	/** Sessions at `address` (default service: the app), oldest first. */
	sessionsAt(address: ActorAddress, service = APP_SERVICE): ActorSession[] {
		return [...this.sessions.values()]
			.filter(
				(s) =>
					s.service === service && s.address?.family === address.family && s.address?.name === address.name
			)
			.sort((a, b) => a.epoch - b.epoch || Number(a.spans[0]!.startTimeUnixNano - b.spans[0]!.startTimeUnixNano));
	}

	/** Human-readable summary, for failure messages. */
	describe(service = APP_SERVICE): string {
		return [...this.sessions.values()]
			.filter((s) => s.service === service)
			.map(
				(s) =>
					`${s.key} ${s.address ? formatAddress(s.address) : (s.family ?? '?')}: events=[${s.events.join(', ')}] entered=[${s.entered.join(' → ')}] final=${s.finalState ?? '-'}${s.doneReason ? ` (${s.doneReason})` : ''}`
			)
			.join('\n');
	}
}

// ---------------------------------------------------------------------------
// Predicates (for Harness.waitForSpan / Harness.spansMatching)
// ---------------------------------------------------------------------------

export type SpanPredicate = (span: CollectedSpan, index: TraceIndex) => boolean;

const at = (address: ActorAddress, service: string) => (span: CollectedSpan, index: TraceIndex) => {
	if (span.service !== service) return false;
	const a = index.sessionOf(span)?.address;
	return a?.family === address.family && a?.name === address.name;
};

/** The actor at `address` reached a top-level final state (`finalState` if given). */
export const actorFinished =
	(address: ActorAddress, finalState?: string, service = APP_SERVICE): SpanPredicate =>
	(span, index) =>
		isFinished(span) && (finalState === undefined || finalStateOf(span) === finalState) && at(address, service)(span, index);

/** The actor at `address` entered `state` (microstep entry, or active after a macrostep). */
export const actorReachedState =
	(address: ActorAddress, state: string, service = APP_SERVICE): SpanPredicate =>
	(span, index) =>
		(enteredStatesOf(span).includes(state) || (isMacrostep(span) && activeStatesOf(span).includes(state))) &&
		at(address, service)(span, index);

/** The actor at `address` took external event `event` (a macrostep ran for it). */
export const eventDelivered =
	(address: ActorAddress, event: string, service = APP_SERVICE): SpanPredicate =>
	(span, index) =>
		isMacrostep(span) && eventNameOf(span) === event && at(address, service)(span, index);

/** Any span of `service` whose event data mentions `needle` (e.g. an issue key). */
export const mentions =
	(needle: string, service = APP_SERVICE): SpanPredicate =>
	(span) =>
		span.service === service && (eventDataOf(span) ?? '').includes(needle);

/** A span of `service` from process generation `epoch`. */
export const inEpoch =
	(epoch: number, service = APP_SERVICE): SpanPredicate =>
	(span) =>
		span.service === service && span.epoch === epoch;

export const and =
	(...ps: SpanPredicate[]): SpanPredicate =>
	(span, index) =>
		ps.every((p) => p(span, index));

export const or =
	(...ps: SpanPredicate[]): SpanPredicate =>
	(span, index) =>
		ps.some((p) => p(span, index));

/** Final states reached by all sessions at `address`, oldest first. */
export function finalStates(index: TraceIndex, address: ActorAddress, service = APP_SERVICE): string[] {
	return index
		.sessionsAt(address, service)
		.map((s) => s.finalState)
		.filter((s): s is string => !!s);
}
