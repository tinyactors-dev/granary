/**
 * What every granary host shares at run time (ADR 0300): asking an actor
 * with a timeout, exporting telemetry to an OTLP endpoint, and reading the
 * state of every actor of a chart.
 */
import { StaleError, type Actor, type Host } from '@tinyactors/node';

/**
 * `ask` the actor `which` names (a name, session or address) and resolve
 * with its reply's data. Rejects with `StaleError` at once when no such
 * actor is live, and with an error after `timeoutMs` when it does not
 * answer (the chart ended, or never replies to `event`).
 */
export async function askActor<T = unknown>(host: Host, which: string | bigint | Actor, event: string, data?: unknown, timeoutMs = 15_000): Promise<T> {
	const actor = host.actor(which);
	try {
		const [, reply] = await actor.ask(event, data as never, { signal: AbortSignal.timeout(timeoutMs) });
		return reply as T;
	} catch (e) {
		if (e instanceof Error && e.name === 'TimeoutError') throw new Error(`no reply to ${event} within ${timeoutMs} ms`);
		throw e;
	}
}

/** The actor `which` names, or undefined when none is live. */
export function findActor(host: Host, which: string | bigint): Actor | undefined {
	try {
		return host.actor(which);
	} catch (e) {
		if (e instanceof StaleError) return undefined;
		throw e;
	}
}

/** The variables of every live actor of `chart` (actors that end meanwhile are skipped). */
export async function contextsOf(host: Host, chart: string): Promise<{ actor: Actor; variables: Record<string, unknown> }[]> {
	const out: { actor: Actor; variables: Record<string, unknown> }[] = [];
	for (const actor of await host.actors({ chart })) {
		try {
			out.push({ actor, variables: (await actor.context()).variables as Record<string, unknown> });
		} catch (e) {
			if (!(e instanceof StaleError)) throw e;
		}
	}
	return out;
}

/**
 * A `telemetry` handler that posts each OTLP request to `<endpoint>/v1/<signal>`
 * and forgets it (the fakes' and loadgen's export: best effort, no retries).
 */
export function postOTLP(endpoint: string): (signal: 'traces' | 'logs', data: Uint8Array) => void {
	const base = endpoint.replace(/\/+$/, '');
	return (signal, data) => {
		if (!data.byteLength) return;
		void fetch(`${base}/v1/${signal}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-protobuf' },
			body: data as Uint8Array<ArrayBuffer>
		}).catch(() => undefined);
	};
}

/** The host config's telemetry part for an exporting host: ms ticks, a request at most `flushMs` after its first record. */
export function telemetryConfig(service: string, opts: { values?: boolean; flushMs?: number } = {}) {
	return {
		system: { ticksPerSecond: 1000 },
		telemetry: { flushInterval: opts.flushMs ?? 200, values: opts.values ?? false, resource: { 'service.name': service } }
	};
}
