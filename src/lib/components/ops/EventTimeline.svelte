<!-- The "handled automatically" timeline (ADR 0104). -->
<script lang="ts">
	import type { OpsEvent } from '$lib/ops/contract';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import { EVENT_KIND } from './format';

	let { events, empty = 'Nothing happened.' }: { events: OpsEvent[]; empty?: string } = $props();
	const hasEvidence = (e: OpsEvent) => e.evidence !== null && typeof e.evidence === 'object' && Object.keys(e.evidence as object).length > 0;
</script>

{#if events.length}
	<ol class="relative space-y-4 border-l pl-5" data-testid="ops-events">
		{#each events as e (e.id)}
			{@const k = EVENT_KIND[e.kind]}
			<li class="relative">
				<span class="bg-background absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 {e.kind === 'handled' ? 'border-emerald-500' : e.kind === 'attention' ? 'border-amber-500' : 'border-muted-foreground/50'}"></span>
				<div class="flex flex-wrap items-center gap-2 text-xs">
					<StateBadge state={k.label} tone={k.tone} />
					<span class="text-muted-foreground"><RelativeTime ms={e.at} /></span>
					{#if e.conditionId}<a href="/ops/conditions#{e.conditionId}" class="text-muted-foreground font-mono hover:underline">{e.conditionId}</a>{/if}
				</div>
				<p class="mt-1 text-sm">{e.message}</p>
				{#if hasEvidence(e)}<JsonBlock value={e.evidence} preset="inline" rootLabel="evidence" class="mt-1.5" />{/if}
			</li>
		{/each}
	</ol>
{:else}
	<p class="text-muted-foreground text-sm">{empty}</p>
{/if}
