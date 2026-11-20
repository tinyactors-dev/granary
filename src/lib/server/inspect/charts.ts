/**
 * Chart structures for the inspector (ADR 0056, ADR 0300): the SCXML each
 * actor file builds, read into a JSON-safe `ChartStructure`, cached per
 * chart name. A running actor's chart is the one granary compiled at boot.
 */
import type { ChartStructure } from '../../schemas/api';
import { toChart } from './chart-structure';
import { allowlistChart } from '../actors/allowlist';
import { issueChart } from '../actors/issue';
import { deliveryCatchupChart } from '../actors/delivery-catchup';

const SOURCES = {
	issue: { build: issueChart, file: 'src/lib/server/actors/issue.ts' },
	allowlist: { build: allowlistChart, file: 'src/lib/server/actors/allowlist.ts' },
	'delivery-catchup': { build: deliveryCatchupChart, file: 'src/lib/server/actors/delivery-catchup.ts' }
} as const;

const cache = new Map<string, ChartStructure | null>();

/** The chart structure of a chart granary builds, or null when it is not one of ours. */
export function chartFor(name: string): ChartStructure | null {
	if (cache.has(name)) return cache.get(name)!;
	const known = (SOURCES as Record<string, { build: () => { name: string; text: string }; file: string }>)[name];
	const chart = known ? toChart(known.build(), known.file) : null;
	cache.set(name, chart);
	return chart;
}

export { toChart };
