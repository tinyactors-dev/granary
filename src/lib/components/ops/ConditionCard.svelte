<!-- One watchdog condition (ADR 0100/0101): what happened, what was tried, what to do. -->
<script lang="ts">
	import type { Condition } from '$lib/ops/contract';
	import { Button } from '$lib/components/ui/button/index.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import { describeError } from '$lib/components/app/format';
	import { acknowledgeOpsCondition } from '$lib/remote/ops.remote';
	import { CONDITION_STATE, duration } from './format';

	let { condition: c, compact = false }: { condition: Condition; compact?: boolean } = $props();
	let busy = $state(false);
	const st = $derived(CONDITION_STATE[c.state]);

	async function ack() {
		busy = true;
		try {
			await acknowledgeOpsCondition({ id: c.id });
			toast.success(`Acknowledged "${c.title}"`, { description: 'It will come back if it happens again.' });
		} catch (e) {
			toast.error('Could not acknowledge', { description: describeError(e).message });
		} finally {
			busy = false;
		}
	}
</script>

<article id={c.id} class="bg-card scroll-mt-20 rounded-xl border p-4 target:ring-2 target:ring-sky-500/40" data-testid="ops-condition" data-state={c.state}>
	<div class="flex flex-wrap items-start justify-between gap-2">
		<div class="min-w-0">
			<h2 class="font-medium">{c.title}</h2>
			<p class="text-muted-foreground font-mono text-xs">{c.id}</p>
		</div>
		<div class="flex items-center gap-2">
			<StateBadge state={st.label} tone={st.tone} />
			{#if c.state === 'attention'}
				<AdminOnly reason="Only admins can acknowledge">
					{#snippet children({ disabled })}
						<Button size="sm" variant="outline" disabled={disabled || busy} onclick={ack}>
							{#if busy}<LoaderCircleIcon class="animate-spin" />{:else}<CheckIcon />{/if} Acknowledge
						</Button>
					{/snippet}
				</AdminOnly>
			{/if}
		</div>
	</div>
	<p class="mt-2 text-sm">{c.explanation}</p>
	{#if !compact}
		<dl class="text-muted-foreground mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
			<dt>Since</dt><dd class="text-foreground"><RelativeTime ms={c.since} /></dd>
			<dt>Grace period</dt><dd class="text-foreground">{duration(c.gracePeriodMs)}</dd>
			<dt>Self-healing</dt>
			<dd class="text-foreground">{c.remediations.length ? c.remediations.join(' → ') : 'none (needs a decision)'}</dd>
			<dt>Last tried</dt>
			<dd class="text-foreground">
				{#if c.lastRemediation}{c.lastRemediation.action} · {c.lastRemediation.outcome} · <RelativeTime ms={c.lastRemediation.at} />{:else}—{/if}
			</dd>
			{#if c.acknowledgedBy}<dt>Acknowledged by</dt><dd class="text-foreground">{c.acknowledgedBy}</dd>{/if}
		</dl>
		{#if Object.keys(c.facts).length}
			<JsonBlock value={c.facts} preset="inline" rootLabel="facts" class="mt-3" />
		{/if}
	{/if}
</article>
