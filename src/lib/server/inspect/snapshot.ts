/**
 * Summaries and snapshots of live actors (ADR 0056, ADR 0300), from
 * `actor.state()`, `actor.context()` and `actor.get()`. The host gives no
 * actor's name, so the caller passes the one it spawned the actor under.
 */
import type { Actor, StateValue } from '@tinyactors/node';
import type { ActorDetail, ActorSnapshot, ActorSummary, DelayedSendSummary } from '../../schemas/api';
import { parseAddress } from '../../schemas/actors';
import { chartFor } from './charts';
import { toJsonSafe } from './json-safe';

/** The active atomic states of a state value (`{open: 'browsing'}` → `['browsing']`). */
export function activeStates(value: StateValue): string[] {
	if (typeof value === 'string') return [value];
	return Object.values(value).flatMap(activeStates);
}

async function facts(actor: Actor) {
	const [state, info] = await Promise.all([actor.state(), actor.get()]);
	// Delayed sends are due on the host's clock (`host.now()`); shown as epoch ms.
	const offset = Date.now() - actor.host.now();
	const delayedSends: DelayedSendSummary[] = info.timers.map((t) => ({ id: t.sendid, event: t.event, due: Math.round(t.due + offset) }));
	return { state, info, delayedSends };
}

function summaryOf(actor: Actor, name: string | null, f: Awaited<ReturnType<typeof facts>>): ActorSummary {
	return {
		address: name ? parseAddress(name) : null,
		id: name ?? `#${actor.id}`,
		family: f.info.chart,
		segment: f.info.segment,
		sessionId: String(actor.id),
		activeStates: activeStates(f.state.value),
		delayedSendCount: f.info.timersPending,
		mailboxDepth: f.info.mailbox,
		invocations: f.info.invocations
	};
}

/** A summary for lists; throws `StaleError` when the actor ended meanwhile. */
export async function summaryOfActor(actor: Actor, name: string | null): Promise<ActorSummary> {
	return summaryOf(actor, name, await facts(actor));
}

/** The issue page's actor panel: the summary, the variables and the delayed sends. */
export async function detailOfActor(actor: Actor, name: string | null): Promise<ActorDetail> {
	const [f, context] = await Promise.all([facts(actor), actor.context()]);
	return { ...summaryOf(actor, name, f), data: toJsonSafe(context.variables), delayedSends: f.delayedSends };
}

/** Everything the inspector shows about one actor. */
export async function snapshotOf(actor: Actor, name: string | null): Promise<ActorSnapshot> {
	const [f, context] = await Promise.all([facts(actor), actor.context()]);
	const summary = summaryOf(actor, name, f);
	const issueKey = summary.address?.family === 'issue' ? summary.address.name : null;
	return {
		...summary,
		capturedAt: Date.now(),
		state: toJsonSafe(f.state.value),
		history: toJsonSafe(f.state.history),
		data: toJsonSafe(context.variables),
		delayedSends: f.delayedSends,
		chart: chartFor(f.info.chart),
		issueKey
	};
}
