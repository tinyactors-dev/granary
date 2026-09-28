/**
 * The ops tinyactors System (ADR 0081, 0093, 0120): separate from granary's,
 * in the same process. Owns the hooks (done/fault/dead letters), the trace
 * sink (`service.name=granary-ops`, `detail: 'summary'`) and loop breaking:
 * spans of excluded definitions (the telemetry-sink family) are removed
 * before ops traces reach the fan-out.
 */
import { createSystem, type Actor, type ActorAddress, type Definition, type IOProcessor, type System } from '@tinyactors/node';
import type { OpsLogger, TelemetryBatch } from './contract';
import { filterSpans, rewriteSpans, type SpanFacts, type SpanEdit } from './telemetry/otlp-wire';
import { familySpanName, parseTinyactorsName, SPAN_KIND_ATTR, SPAN_NAME_ATTR } from './telemetry/span-name';
import { OPS_SERVICE } from './telemetry/fanout';

export interface OpsSystem {
	system: System;
	/** Remember a named actor's address (spawned or loaded). */
	note(address: ActorAddress): void;
	/** Addresses known to be (or have been) resident. */
	known(): ActorAddress[];
	spawn<Data extends object>(definition: Definition<Data>, address: ActorAddress, binding?: Partial<Data>): Actor<Data>;
	post(target: ActorAddress, event: string, data?: unknown): void;
	/** Never export spans of this definition (loop breaking, ADR 0093). */
	excludeFromTraces(definition: Definition<object> | Definition<never>): void;
	stats: { deadLetters: number; faults: number };
	close(): void;
}

const key = (a: ActorAddress) => `${a.family}/${a.name}`;

export function createOpsSystem(opts: {
	io: Record<string, IOProcessor>;
	log: OpsLogger;
	/** Where ops' own traces go (the fan-out). */
	exportTraces: (batch: TelemetryBatch) => void;
	/** Whether anyone wants ops traces right now (skips work when not). */
	wantsTraces: () => boolean;
}): OpsSystem {
	const stats = { deadLetters: 0, faults: 0 };
	const addresses = new Map<string, ActorAddress>();
	const excluded = new Set<number>();
	/** scxml session id → address, for naming spans (ADR 0155). */
	const sessions = new Map<string, ActorAddress>();
	const remember = (actor: Actor<object> | Actor<never> | undefined, address: ActorAddress) => {
		try {
			if (actor && !actor.destroyed) sessions.set(String(system.inspect(actor).sessionID), address);
		} catch {
			/* gone already */
		}
	};
	const addressOf = (session: string): ActorAddress | undefined => {
		const hit = sessions.get(session);
		if (hit) return hit;
		for (const a of addresses.values()) remember(system.findActor(a) as Actor<object> | undefined, a); // loaded/respawned actors
		if (sessions.size > 10_000) sessions.clear();
		return sessions.get(session);
	};
	/** `scxml.macrostep x` → `<family> macrostep x`, plus actor and tinyactors attributes. */
	const nameSpan = (span: SpanFacts): SpanEdit | null => {
		const p = parseTinyactorsName(span.name);
		if (!p) return null;
		const session = span.attr('scxml.session_id');
		const address = session === undefined ? undefined : addressOf(String(session));
		const attributes: Record<string, string> = { [SPAN_NAME_ATTR]: span.name, [SPAN_KIND_ATTR]: p.kind };
		if (address) {
			attributes['granary.actor.family'] = address.family;
			attributes['granary.actor.name'] = address.name;
			attributes['granary.actor.address'] = key(address);
		}
		return { name: familySpanName(span.name, address?.family), attributes };
	};
	const system = createSystem({
		io: opts.io,
		fault(record) {
			stats.faults++;
			opts.log.error(`ops: actor faulted in ${record.operation}: ${record.code} ${record.message}`);
			// Free it so the next mail loads a fresh actor from the database.
			queueMicrotask(() => {
				try {
					if (!system.closed && system.exists(record.actor)) system.destroy(record.actor);
				} catch {
					/* gone */
				}
			});
		},
		deadLetter(record) {
			stats.deadLetters++;
			if (record.reason === 'destroyed' || record.reason === 'done') return; // replies to finished actors are expected
			const target = 'family' in record.target ? key(record.target) : `#${record.target.slot}`;
			opts.log.warn(`ops: dead letter ${record.event} → ${target} (${record.reason})`);
		}
	});

	system.setTraceSink(
		(traces) => {
			if (!opts.wantsTraces()) return;
			try {
				const r = excluded.size ? filterSpans(traces, (s) => !excluded.has(Number(s.attr('scxml.definition') ?? -1))) : { bytes: traces };
				if (!r.bytes) return;
				const named = rewriteSpans(r.bytes, nameSpan).bytes;
				opts.exportTraces({ signal: 'traces', contentType: 'application/x-protobuf', bytes: named, service: OPS_SERVICE, producedAt: Date.now() });
			} catch (e) {
				opts.log.warn('ops: could not filter an ops trace batch; dropped', e instanceof Error ? e.message : e);
			}
		},
		{ resource: { 'service.name': OPS_SERVICE }, detail: 'summary', values: false, logs: false }
	);

	return {
		system,
		stats,
		note(address) {
			addresses.set(key(address), address);
			remember(system.findActor(address) as Actor<object> | undefined, address);
		},
		known: () => [...addresses.values()],
		spawn(definition, address, binding) {
			const actor = system.spawn(definition, { address, ...(binding ? { binding } : {}) });
			addresses.set(key(address), address);
			remember(actor as Actor<object>, address);
			return actor;
		},
		post(target, event, data) {
			system.post(target, event, data);
		},
		excludeFromTraces(definition) {
			excluded.add(Number(definition.id));
		},
		close() {
			try {
				system.close();
			} catch (e) {
				opts.log.error('ops: closing the ops system failed', e);
			}
		}
	};
}
