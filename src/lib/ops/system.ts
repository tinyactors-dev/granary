/**
 * The ops tinyactors host (ADR 0081, 0093, 0120): separate from granary's,
 * in the same process, system `granary-ops`.
 *
 * - **Names.** Every ops actor is spawned under `<family>/<name>` (its chart
 *   is the family) through `spawn`/`replace`, which keep the name → actor
 *   map that `find` reads: a terminated actor's name still resolves in the
 *   host until its next turn, so the map, not `host.actor(name)`, says which
 *   actor holds a name.
 * - **Virtual actors** (conditions, backup runs, uploads) have no loader in
 *   0.4.0: `ensure(name)` finds the actor or spawns it with the params its
 *   feature's spawner reads from ops.sqlite (null: the row is terminal or
 *   gone). Charts reach such actors through the `ops-route` I/O processor,
 *   which runs `ensure` and forwards with the sender as origin.
 * - **Telemetry.** Traces export with `detail: 'summary'` and no values; a
 *   trace rule drops every step of the `telemetry-sink` chart, including
 *   steps its processor's answers trigger, so shipping telemetry never makes
 *   telemetry (loop breaking, ADR 0093). `metrics()` is the host's counters.
 * - **Faults.** `onError` logs and counts actors that ended on a fault;
 *   `onHandlerError` logs what a processor threw.
 */
import { compileCharts, Host, StaleError, type Actor, type IOProcessor, type Send, type Source, type Value } from '@tinyactors/node';
import type { OpsLogger, TelemetryBatch } from './contract';
import { OPS_IO, OPS_SYSTEM, parseOpsName } from './schemas/events';
import { OPS_SERVICE } from './telemetry/fanout';

/** Params of a virtual actor read from its row, or null when it must not exist. */
export type Spawner = (name: string) => Record<string, Value> | null;

export interface OpsActors {
	readonly host: Host;
	/** Actors of this host that ended on a fault since it started. */
	readonly stats: { faults: number };
	/** Spawn `<family>/<name>` of chart `family`. */
	spawn(name: string, params?: Record<string, Value>): Actor;
	/** Terminate the actor holding `name` (if any) and spawn a fresh one with `params`. */
	replace(name: string, params?: Record<string, Value>): Actor;
	/** The live actor holding `name`. */
	find(name: string): Actor | undefined;
	/** `find`, else spawn a virtual actor from its family's spawner; undefined when there is none to spawn. */
	ensure(name: string): Actor | undefined;
	/** `ensure` + send; false (and a debug log) when no actor holds or may hold the name. */
	send(name: string, event: string, data?: Value, options?: { origin?: Send['origin']; traceparent?: string }): boolean;
	/** Names of the live actors, by `String(actor.id)`. */
	names(): Map<string, string>;
	/** Register the spawner of a virtual family. */
	setSpawner(family: string, spawner: Spawner): void;
	close(): Promise<void>;
}

/** The `ops-route` processor: chart-to-chart sends by name, through `ensure` (missing-actors.md, "The application routes it"). */
function routeProcessor(ops: () => OpsActors, log: OpsLogger): IOProcessor {
	return {
		receive(send) {
			const target = typeof send.target === 'string' ? send.target : String(send.target ?? '');
			if (!ops().send(target, send.event, send.data as Value, { origin: send.origin, traceparent: send.traceparent }))
				log.debug?.(`ops: ${send.event} to ${target} dropped: no such actor`);
		}
	};
}

export function createOpsActors(opts: {
	charts: Source[];
	io: Record<string, IOProcessor>;
	log: OpsLogger;
	/** Where ops' own traces go (the fan-out). */
	exportTraces: (batch: TelemetryBatch) => void;
	/** Whether anyone wants ops traces right now (skips work when not). */
	wantsTraces: () => boolean;
	/** Flush interval of the trace encoder, ms. */
	flushMs?: number;
}): OpsActors {
	const stats = { faults: 0 };
	const byName = new Map<string, Actor>();
	const nameById = new Map<string, string>();
	const spawners = new Map<string, Spawner>();
	const forget = (actor: Actor) => {
		const name = nameById.get(String(actor.id));
		nameById.delete(String(actor.id));
		if (name !== undefined && byName.get(name)?.equals(actor)) byName.delete(name);
		return name;
	};

	const compiled = compileCharts(opts.charts, { warningsAsErrors: true });
	let ops: OpsActors;
	const host = new Host(compiled, {
		system: OPS_SYSTEM,
		ioProcessors: { ...opts.io, [OPS_IO.route]: routeProcessor(() => ops, opts.log) },
		config: {
			system: { ticksPerSecond: 1000 },
			telemetry: { flushInterval: opts.flushMs ?? 1000, values: false, logs: false, resource: { 'service.name': OPS_SERVICE } }
		},
		telemetry: (signal, bytes) => {
			if (signal !== 'traces' || !bytes.byteLength || !opts.wantsTraces()) return;
			opts.exportTraces({ signal: 'traces', contentType: 'application/x-protobuf', bytes, service: OPS_SERVICE, producedAt: Date.now() });
		},
		onDone: (actor) => void forget(actor),
		onError: (actor, error) => {
			stats.faults++;
			const name = forget(actor);
			opts.log.error(`ops: actor ${name ?? String(actor)} ended on a fault: ${error.message}`);
		},
		onHandlerError: (error, effect) => {
			const what = effect && 'event' in effect ? ` handling ${(effect as Send).event}` : '';
			opts.log.error(`ops: an I/O processor failed${what}`, error);
		}
	});
	compiled.close();
	void host
		.traceConfigure({ detail: 'summary', values: false, rules: [{ chart: 'telemetry-sink', sample: 'drop' }] })
		.catch((e) => opts.log.warn('ops: could not configure tracing', e instanceof Error ? e.message : e));

	const chartOf = (name: string) => {
		const a = parseOpsName(name);
		if (!a) throw new Error(`ops: ${name} is not an ops actor name (<family>/<name>)`);
		return a.family;
	};

	ops = {
		host,
		stats,
		spawn(name, params) {
			const actor = host.spawn(chartOf(name), { name, ...(params ? { params } : {}) });
			byName.set(name, actor);
			nameById.set(String(actor.id), name);
			return actor;
		},
		replace(name, params) {
			const old = ops.find(name);
			if (old) {
				forget(old);
				try {
					old.terminate();
				} catch (e) {
					if (!(e instanceof StaleError)) throw e;
				}
			}
			return ops.spawn(name, params);
		},
		find(name) {
			const actor = byName.get(name);
			if (!actor) return undefined;
			try {
				return host.actor(actor);
			} catch (e) {
				if (!(e instanceof StaleError)) throw e;
				forget(actor);
				return undefined;
			}
		},
		ensure(name) {
			const found = ops.find(name);
			if (found) return found;
			const a = parseOpsName(name);
			const spawner = a && spawners.get(a.family);
			if (!spawner) return undefined;
			const params = spawner(a.name);
			return params ? ops.spawn(name, params) : undefined;
		},
		send(name, event, data, options) {
			const actor = ops.ensure(name);
			if (!actor) return false;
			try {
				actor.send(event, data, options);
				return true;
			} catch (e) {
				if (!(e instanceof StaleError)) throw e;
				forget(actor);
				return false;
			}
		},
		names: () => new Map(nameById),
		setSpawner(family, spawner) {
			spawners.set(family, spawner);
		},
		async close() {
			try {
				await host[Symbol.asyncDispose]();
			} catch (e) {
				opts.log.error('ops: closing the ops host failed', e);
			}
		}
	};
	return ops;
}
