/**
 * `faults/main` — injected failures (ADR 0134). `fault.check {target, method,
 * path}` consumes the first live fault whose target matches, whose method
 * matches (`*`/absent = any) and whose unanchored `pathPattern` matches the
 * path (for S3: path + query, so sub-resources like `?uploads` can be
 * targeted). Exhausted faults stay listed with `remaining: 0`.
 */
import { statechart } from '@tinyactors/node';
import type { InjectFaultRequest } from '../schemas';
import { answer } from '../io/reply';

export const FAULTS_ADDRESS = { family: 'faults', name: 'main' } as const;

export type Fault = InjectFaultRequest & { id: string; remaining: number };

export interface FaultsData {
	faults: Fault[];
	out: unknown;
}

export const FAULT_EVENTS = { inject: 'fault.inject', clear: 'fault.clear', check: 'fault.check' } as const;

export interface CheckFaultEvent {
	target: 's3' | 'otlp' | 'exe-proxy';
	method: string;
	path: string;
}

export const faultsChart = statechart<FaultsData>({ family: 'faults', revision: 'v1' })
	.dataExpression('faults', () => [])
	.data('out', null)
	.state('ready', (s) =>
		s
			.on(
				FAULT_EVENTS.inject,
				answer<FaultsData, InjectFaultRequest & { id: string; reqId?: string }>((d, e) => {
					const { reqId: _r, ...fault } = e;
					d.faults.push({ ...fault, remaining: fault.count });
					return { id: e.id };
				})
			)
			.on(
				FAULT_EVENTS.clear,
				answer<FaultsData>((d) => {
					d.faults = [];
					return { ok: true };
				})
			)
			.on(
				FAULT_EVENTS.check,
				answer<FaultsData, CheckFaultEvent>((d, e): Fault | null => {
					for (const f of d.faults) {
						if (f.remaining <= 0 || f.target !== e.target) continue;
						if (f.method && f.method !== '*' && f.method !== e.method.toUpperCase()) continue;
						if (!new RegExp(f.pathPattern).test(e.path)) continue;
						f.remaining -= 1;
						return { ...f };
					}
					return null;
				})
			)
	);
