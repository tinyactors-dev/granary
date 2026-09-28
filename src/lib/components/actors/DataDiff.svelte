<!-- Differences between a frozen snapshot and the live one (ADR 0056). -->
<script lang="ts">
	import type { ActorSnapshot } from '$lib/schemas/api';
	import { diffJson, inlineJson } from './inspect';

	let { before, after }: { before: ActorSnapshot; after: ActorSnapshot } = $props();

	const changes = $derived(diffJson(before.data, after.data));
	const statesChanged = $derived(before.activeStates.join(' ') !== after.activeStates.join(' '));
	const stepChanged = $derived(before.macrostep !== after.macrostep || before.microstep !== after.microstep);
	const KIND = { added: 'text-emerald-700 dark:text-emerald-400', removed: 'text-red-700 dark:text-red-400', changed: 'text-amber-700 dark:text-amber-400' };
</script>

<div class="space-y-2 text-sm" data-testid="data-diff">
	{#if statesChanged}
		<div>
			<span class="text-muted-foreground">states:</span>
			<span class="font-mono">{before.activeStates.join(', ') || '—'}</span> →
			<span class="font-mono font-semibold">{after.activeStates.join(', ') || '—'}</span>
		</div>
	{/if}
	{#if stepChanged}
		<div>
			<span class="text-muted-foreground">step:</span>
			<span class="font-mono">{before.macrostep}.{before.microstep} → {after.macrostep}.{after.microstep}</span>
		</div>
	{/if}
	{#if changes.length}
		<ul class="bg-muted/40 divide-y rounded-md border font-mono text-xs">
			{#each changes as c (c.path)}
				<li class="flex flex-wrap gap-x-2 px-2 py-1">
					<span class={KIND[c.kind]}>{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}</span>
					<span class="font-medium">{c.path}</span>
					{#if c.kind !== 'added'}<span class="text-muted-foreground line-through">{inlineJson(c.before)}</span>{/if}
					{#if c.kind !== 'removed'}<span>{inlineJson(c.after)}</span>{/if}
				</li>
			{/each}
		</ul>
	{:else if !statesChanged && !stepChanged}
		<p class="text-muted-foreground">No changes since the snapshot was captured.</p>
	{:else}
		<p class="text-muted-foreground">Data unchanged.</p>
	{/if}
</div>
