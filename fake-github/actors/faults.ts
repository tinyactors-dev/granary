/**
 * `faults/main` — injected REST failures (ADR 0035, ADR 0060).
 *
 * `fault.inject` appends a fault with a budget (`remaining = count`).
 * The server asks `fault.check {method, path}` before serving every
 * GitHub-compatible REST call; the first fault whose method matches (`*` =
 * any) and whose `new RegExp(pathPattern)` matches the pathname (unanchored)
 * is consumed (remaining−1) and returned, else null. Exhausted faults stay
 * listed with `remaining: 0`.
 */
import { statechart } from '@tinyactors/node';
import type { FakeFault, InjectFaultRequest } from '../schemas';
import { answer } from '../io/reply';

export const FAULTS_ADDRESS = { family: 'faults', name: 'main' } as const;

export interface FaultsData {
	faults: FakeFault[];
	out: unknown;
}

export const FAULT_EVENTS = { inject: 'fault.inject', check: 'fault.check' } as const;

export type InjectFaultEvent = InjectFaultRequest & { id: string };
export interface CheckFaultEvent {
	method: string;
	path: string;
}
export type FaultHit = Pick<FakeFault, 'id' | 'status' | 'retryAfter'>;

export const faultsChart = statechart<FaultsData>({ family: 'faults', revision: 'v1' })
	.dataExpression('faults', () => [])
	.data('out', null)
	.state('ready', (s) =>
		s
			.on(
				FAULT_EVENTS.inject,
				answer<FaultsData, InjectFaultEvent>((d, e) => {
					const fault: FakeFault = {
						id: e.id,
						method: e.method,
						pathPattern: e.pathPattern,
						status: e.status,
						remaining: e.count
					};
					if (e.retryAfter !== undefined) fault.retryAfter = e.retryAfter;
					d.faults.push(fault);
					return { id: e.id };
				})
			)
			.on(
				FAULT_EVENTS.check,
				answer<FaultsData, CheckFaultEvent>((d, e): FaultHit | null => {
					for (const f of d.faults) {
						if (f.remaining <= 0) continue;
						if (f.method !== '*' && f.method !== e.method.toUpperCase()) continue;
						if (!new RegExp(f.pathPattern).test(e.path)) continue;
						f.remaining -= 1;
						const hit: FaultHit = { id: f.id, status: f.status };
						if (f.retryAfter !== undefined) hit.retryAfter = f.retryAfter;
						return hit;
					}
					return null;
				})
			)
	);
