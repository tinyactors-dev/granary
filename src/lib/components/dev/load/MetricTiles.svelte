<!-- Headline numbers of a scenario: stat tiles, not charts (dataviz: single values). -->
<script lang="ts">
	import type { Metrics } from '$lib/schemas/dev';
	import { duration } from './meta';

	let { m, violations }: { m: Metrics; violations: number } = $props();

	const tiles = $derived([
		{ label: 'Issues opened', value: String(m.issuesOpened), note: `${m.expectedOpen} should stay open · ${m.expectedClosed} should close` },
		{ label: 'Closed by granary', value: String(m.closedByGranary), note: `${m.pendingClose} pending · ${m.overdue} overdue` },
		{ label: 'Close latency p95', value: duration(m.latency.p95), note: `p50 ${duration(m.latency.p50)} · max ${duration(m.latency.max)}` },
		{ label: 'Webhooks', value: String(m.deliveries), note: `${m.deliveryFailures} failed · ${m.rawDeliveries} raw fuzz` },
		{ label: 'Chaos', value: String(m.faultsInjected + m.redeliveries), note: `${m.faultsInjected} faults · ${m.redeliveries} redeliveries` },
		{ label: 'Persona actions', value: String(m.personaActions), note: `${m.personaErrors} errors · ${m.throughputPerMin}/min issues` }
	]);
</script>

<div class="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
	<div
		class="rounded-lg border p-3 {violations > 0 ? 'border-red-500/40 bg-red-500/5' : 'bg-card'}"
		data-testid="tile-violations"
	>
		<div class="text-muted-foreground text-xs">Invariant violations</div>
		<div class="mt-1 text-2xl font-semibold tabular-nums {violations > 0 ? 'text-red-600 dark:text-red-400' : ''}">{violations}</div>
		<div class="text-muted-foreground mt-0.5 text-xs">{violations > 0 ? 'see evidence below' : 'granary kept every promise'}</div>
	</div>
	{#each tiles as t (t.label)}
		<div class="bg-card rounded-lg border p-3">
			<div class="text-muted-foreground text-xs">{t.label}</div>
			<div class="mt-1 text-2xl font-semibold tabular-nums">{t.value}</div>
			<div class="text-muted-foreground mt-0.5 truncate text-xs" title={t.note}>{t.note}</div>
		</div>
	{/each}
</div>
