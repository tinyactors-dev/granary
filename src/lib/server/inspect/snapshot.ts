/**
 * Build an `ActorSnapshot` from a live tinyactors actor (ADR 0056).
 */
import type { ActorAddress, ActorID, ActorInspection, EventOrigin, InspectedEvent, System } from '@tinyactors/node';
import type { ActorSnapshot, ActorSummary, SnapshotEvent } from '../../schemas/api';
import { formatAddress } from '../../schemas/actors';
import { chartFor } from './charts';
import { toJsonSafe } from './json-safe';

const MAILBOX_LIMIT = 100;

const revisionText = (r: string | Uint8Array): string =>
	typeof r === 'string' ? r : Buffer.from(r).toString('hex');

function describeOrigin(o: EventOrigin | undefined): string | null {
	if (!o) return null;
	if (o.uri) return o.uri;
	if (o.kind === 'actor') {
		const a = o.actor as ActorAddress | ActorID;
		return 'family' in a ? `#_actor_${a.family}/${a.name}` : `#${a.slot}:${a.generation}`;
	}
	if (o.kind === 'invocation') return `invocation ${o.invocation}`;
	return `${o.type} (io)`;
}

function event(e: InspectedEvent): SnapshotEvent {
	return {
		name: e.name,
		type: e.type,
		sendId: e.sendID ?? null,
		origin: describeOrigin(e.origin),
		data: toJsonSafe(e.data)
	};
}

function destination(d: 'self' | ActorAddress | ActorID | null): string | null {
	if (d === null) return null;
	if (d === 'self') return 'self';
	return 'family' in d ? formatAddress(d) : `#${d.slot}:${d.generation}`;
}

/**
 * Snapshot the actor inspected by `i`. `summary` supplies the fields shared
 * with `ActorSummary` (address, ids, mailbox depth, …).
 */
export function snapshotOf(
	system: System,
	i: ActorInspection,
	summary: ActorSummary
): ActorSnapshot {
	const capturedAt = Date.now();
	const offset = capturedAt - system.time;

	let mailbox: ActorSnapshot['mailbox'] = [];
	let mailboxTruncated = false;
	try {
		const raw = system.mailbox(i.actor, { limit: MAILBOX_LIMIT + 1 });
		mailboxTruncated = raw.length > MAILBOX_LIMIT;
		mailbox = raw.slice(0, MAILBOX_LIMIT).map((m) => ({
			event: m.event,
			data: toJsonSafe(m.data),
			awaited: m.awaited,
			transition: m.transition ? `${m.transition.source ?? '(root)'} → ${m.transition.targets.join(' ')}` : null
		}));
	} catch {
		/* gone between inspect and mailbox */
	}

	let def: ActorSnapshot['definition'] = {
		id: String(i.definitionID),
		family: i.definition.family,
		revision: revisionText(i.definition.revision),
		name: null,
		datamodel: 'javascript',
		binding: 'early',
		stateCount: 0,
		actorCount: 0,
		retired: false
	};
	for (const d of system.definitions()) {
		if (d.id !== i.definitionID) continue;
		def = {
			...def,
			name: d.name ?? null,
			datamodel: d.datamodel,
			binding: d.binding,
			stateCount: d.stateCount,
			actorCount: d.actorCount,
			retired: d.retired
		};
		break;
	}

	const address = summary.address;
	return {
		...summary,
		capturedAt,
		runtime: { slot: i.actor.slot, generation: i.actor.generation },
		definition: def,
		published: i.published,
		microstepInProgress: i.microstepInProgress,
		position: {
			at: i.position.at,
			state: i.position.state,
			transition: i.position.transition,
			action: i.position.action,
			iteration: i.position.iteration
		},
		currentEvent: i.currentEvent ? event(i.currentEvent) : null,
		internalEvents: i.internalEvents.map(event),
		mailbox,
		mailboxTruncated,
		delayedSends: i.delayedSends.map((d) => ({
			id: d.id,
			event: d.event,
			due: Math.round(d.due + offset),
			ioType: d.ioType,
			destination: destination(d.destination),
			target: toJsonSafe(d.target),
			data: toJsonSafe(d.data),
			submitted: d.submitted
		})),
		invocations: i.invocations.map((v) => ({
			id: String(v.id),
			type: v.type,
			active: v.active,
			autoforward: v.autoforward,
			serviceHandle: String(v.serviceHandle)
		})),
		data: toJsonSafe(i.data),
		completion: toJsonSafe(i.completion),
		chart: chartFor(i.definition),
		issueKey: address?.family === 'issue' ? address.name : null
	};
}
