<!-- Invariant status (ADR 0073): status icon + label, never colour alone. -->
<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import HourglassIcon from '@lucide/svelte/icons/hourglass';
	import type { InvariantStatus } from '$lib/schemas/dev';

	let { invariants }: { invariants: InvariantStatus[] } = $props();
</script>

<ul class="divide-y rounded-lg border" data-testid="invariants">
	{#each invariants as inv (inv.id)}
		<li class="flex items-start gap-3 p-3" data-invariant={inv.id} data-status={inv.status}>
			{#if inv.status === 'ok'}
				<CircleCheckIcon class="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
			{:else if inv.status === 'violated'}
				<CircleXIcon class="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400" />
			{:else}
				<HourglassIcon class="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
			{/if}
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-baseline gap-x-2">
					<span class="text-sm font-medium">{inv.title}</span>
					<span class="text-xs font-medium {inv.status === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : inv.status === 'violated' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}">
						{inv.status === 'ok' ? 'holds' : inv.status === 'violated' ? `${inv.violations} violation${inv.violations === 1 ? '' : 's'}` : 'pending'}
					</span>
				</div>
				<p class="text-muted-foreground text-xs">{inv.description}</p>
			</div>
			<span class="text-muted-foreground shrink-0 text-xs tabular-nums" title="issues / deliveries judged">{inv.checked} checked</span>
		</li>
	{/each}
</ul>
