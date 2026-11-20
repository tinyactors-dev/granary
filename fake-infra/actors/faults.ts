/**
 * `faults/main` — injected failures (ADR 0134). `fault.check {target, method,
 * path}` consumes the first live fault whose target matches, whose method
 * matches (`*`/absent = any) and whose unanchored `pathPattern` matches the
 * path (for S3: path + query, so sub-resources like `?uploads` can be
 * targeted). Exhausted faults stay listed with `remaining: 0`.
 */
import { handlerChart } from '../../src/lib/charts';
import type { InjectFaultRequest } from '../schemas';

export const FAULTS_ADDRESS = 'faults/main';

export type Fault = InjectFaultRequest & { id: string; remaining: number };

export interface FaultsData {
	faults: Fault[];
}

export const FAULT_EVENTS = { inject: 'fault.inject', clear: 'fault.clear', check: 'fault.check' } as const;

export interface CheckFaultEvent {
	target: 's3' | 'otlp' | 'exe-proxy';
	method: string;
	path: string;
}

export const faultsChart = handlerChart<FaultsData>({
	name: 'faults',
	initial: { faults: [] },
	handlers: {
		[FAULT_EVENTS.inject]: (d, e: InjectFaultRequest & { id: string }) => {
			d.faults.push({ ...e, remaining: e.count });
			return { id: e.id };
		},
		[FAULT_EVENTS.clear]: (d) => {
			d.faults = [];
			return { ok: true };
		},
		[FAULT_EVENTS.check]: (d, e: CheckFaultEvent): Fault | null => {
			for (const f of d.faults) {
				if (f.remaining <= 0 || f.target !== e.target) continue;
				if (f.method && f.method !== '*' && f.method !== e.method.toUpperCase()) continue;
				if (!new RegExp(f.pathPattern).test(e.path)) continue;
				f.remaining -= 1;
				return { ...f };
			}
			return null;
		}
	}
});
