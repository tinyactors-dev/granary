/**
 * The `reply` I/O processor: how an actor answers the HTTP handler that is
 * waiting for it (ADR 0060).
 *
 * The server calls `ask(system, address, event, data)`: it adds a fresh
 * `reqId` to the event data, posts the event, and waits. The actor answers
 * with `<send event="reply" type="reply">` whose data is `{reqId, result}`
 * (or `{reqIds: [...], result}` to answer several waiters at once);
 * this processor resolves the waiting promise with `result`.
 * `answer(fn)` builds such a transition for a chart.
 */
import type { ActorTarget, IOProcessor, System, TransitionBuilder } from '@tinyactors/node';

export const REPLY_IO = 'reply';
export const REPLY_EVENT = 'reply';

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

/** A result an actor returns for a request it cannot satisfy (unknown issue, …). */
export interface ActorFailure {
	error: string;
	status: number;
}

export const isFailure = (v: unknown): v is ActorFailure =>
	typeof v === 'object' && v !== null && 'error' in v && 'status' in v;

export const replyProcessor: IOProcessor = {
	send(request) {
		const data = request.data as { reqId?: string; reqIds?: string[]; result?: unknown } | undefined;
		const ids = [...(data?.reqIds ?? []), ...(data?.reqId ? [data.reqId] : [])];
		for (const id of ids) {
			const waiting = pending.get(id);
			if (!waiting) continue;
			pending.delete(id);
			clearTimeout(waiting.timer);
			waiting.resolve(data?.result);
		}
	}
};

/** Post `event` to `target` and wait for the actor's `reply`. */
export function ask<T = unknown>(
	system: System,
	target: ActorTarget,
	event: string,
	data: Record<string, unknown> = {},
	timeoutMs = 15_000
): Promise<T> {
	const reqId = crypto.randomUUID();
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(reqId);
			reject(new Error(`no reply to ${event} within ${timeoutMs} ms`));
		}, timeoutMs);
		pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
		// `send` (not `post`) so a dead letter (no such actor) rejects at once.
		system.send(target, event, { ...data, reqId }, { until: 'accepted' }).catch((error: Error) => {
			if (pending.delete(reqId)) {
				clearTimeout(timer);
				reject(error);
			}
		});
	});
}

/** Register a waiter for a reqId an actor already holds (e.g. a delivery spawned with it). */
export function waitForReply<T = unknown>(reqId: string, timeoutMs = 30_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(reqId);
			reject(new Error(`no reply for ${reqId} within ${timeoutMs} ms`));
		}, timeoutMs);
		pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
	});
}

/** Reject every waiter (reset / shutdown). */
export function rejectAllPending(reason: string): void {
	for (const [id, p] of pending) {
		clearTimeout(p.timer);
		p.reject(new Error(reason));
		pending.delete(id);
	}
}

/**
 * A transition body that computes `fn(data, eventData)` and replies with it.
 * A thrown error becomes `{error, status: 500}` so the caller never hangs.
 */
export function answer<D extends { out: unknown }, E = any>(fn: (data: D, event: E) => unknown) {
	return (t: TransitionBuilder<D>): void => {
		t.script(function (this: D, ctx) {
			const ev = ctx.event?.data as (E & { reqId?: string }) | undefined;
			let result: unknown;
			try {
				result = fn(this, ev as E);
			} catch (e) {
				result = { error: (e as Error).message, status: 500 } satisfies ActorFailure;
			}
			this.out = { reqId: ev?.reqId, result };
		}).send(REPLY_EVENT, (s) =>
			s.via(REPLY_IO).data(function (this: D) {
				return this.out;
			})
		);
	};
}
