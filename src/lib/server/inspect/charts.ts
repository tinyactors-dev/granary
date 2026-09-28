/**
 * Chart structures for the inspector (ADR 0056).
 *
 * tinyactors' public API has no "export the definition" call (the debugger
 * uses a private core binding), so we keep what we already have: the
 * `DefinitionSpec` each actor file's builder produces. `chartFor(identity)`
 * rebuilds the spec of the known chart for that family (builders are pure),
 * checks the revision matches the running definition, and converts it into
 * a JSON-safe `ChartStructure`, cached per family+revision.
 */
import type { DefinitionBuilder, DefinitionIdentity } from '@tinyactors/node';
import type { ChartStructure } from '../../schemas/api';
import { toChart } from './chart-structure';
import { allowlistChart } from '../actors/allowlist';
import { issueChart } from '../actors/issue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BUILDERS: Record<string, () => DefinitionBuilder<any>> = {
	issue: issueChart,
	allowlist: allowlistChart
};

const cache = new Map<string, ChartStructure | null>();

const revisionText = (r: string | Uint8Array): string =>
	typeof r === 'string' ? r : Buffer.from(r).toString('hex');

/** The chart structure of a running definition, or null when it is not one of ours. */
export function chartFor(identity: DefinitionIdentity): ChartStructure | null {
	const revision = revisionText(identity.revision);
	const key = `${identity.family}@${revision}`;
	if (cache.has(key)) return cache.get(key)!;
	let chart: ChartStructure | null = null;
	const build = BUILDERS[identity.family];
	if (build) {
		const spec = build().build();
		if (spec.identity && revisionText(spec.identity.revision) === revision) chart = toChart(spec, identity.family, revision);
	}
	cache.set(key, chart);
	return chart;
}

export { toChart };
