<!-- Storage vs caps and billed egress vs budget for one destination (ADR 0096, 0098, 0107). -->
<script lang="ts">
	import type { Projections } from '$lib/ops/contract';
	import Meter from './Meter.svelte';
	import { bytes, duration } from './format';

	let { projections: p }: { projections: Projections } = $props();
</script>

<div class="grid gap-4" data-testid="projections">
	<Meter
		label="Storage at steady state"
		value={p.storage.steadyStateBytes}
		max={p.storage.capBytes}
		format={bytes}
	/>
	<p class="text-muted-foreground -mt-2 text-xs">{p.storage.explanation}</p>
	{#if p.egress}
		<Meter
			label="Billed egress this month (R2 uploads)"
			value={p.egress.usedThisMonthBytes}
			projected={p.egress.projectedMonthBytes}
			max={p.egress.budgetBytes}
			format={bytes}
		/>
		<p class="text-muted-foreground -mt-2 text-xs">
			{p.egress.explanation}
			{#if p.egress.stretched}
				Interval stretched from {duration(p.egress.configuredIntervalMs)} to {duration(p.egress.effectiveIntervalMs)} to stay within budget.
			{/if}
		</p>
	{/if}
</div>
