<!-- Retention dry-run (ADR 0096): exactly what the next pass keeps and deletes. -->
<script lang="ts">
	import type { RetentionPreview } from '$lib/ops/contract';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import { bytes } from './format';

	let { preview: p }: { preview: RetentionPreview } = $props();
	let showKeep = $state(false);
</script>

<div class="grid gap-3 text-sm" data-testid="retention-preview">
	<p>
		The next pass would delete <strong>{p.delete.length}</strong> object{p.delete.length === 1 ? '' : 's'} and keep
		<strong>{p.keep.length}</strong> ({bytes(p.totalBytesAfter)}:
		{Object.entries(p.backupsAfterPerDatabase).map(([db, n]) => `${n} × ${db}`).join(', ')}).
		{#if p.unknownObjects}{p.unknownObjects} unrecognised object{p.unknownObjects === 1 ? ' is' : 's are'} left alone.{/if}
	</p>
	{#if p.floorExceedsCap}
		<p class="rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
			The newest backups that are always kept already exceed the size cap. Raise the cap or lower the floor — this is a decision, not something ops can fix.
		</p>
	{/if}
	{#if p.delete.length}
		<ul class="divide-y rounded-md border" aria-label="Would delete">
			{#each p.delete as o (o.key)}
				<li class="grid gap-0.5 px-3 py-2">
					<code class="truncate text-xs" title={o.key}>{o.key}</code>
					<span class="text-muted-foreground text-xs"><RelativeTime ms={o.createdAt} /> · {bytes(o.bytes)} · {o.reason}</span>
				</li>
			{/each}
		</ul>
	{/if}
	<button type="button" class="text-muted-foreground w-fit text-xs underline" onclick={() => (showKeep = !showKeep)}>
		{showKeep ? 'Hide' : 'Show'} the {p.keep.length} kept backups
	</button>
	{#if showKeep}
		<ul class="text-muted-foreground max-h-64 overflow-y-auto text-xs">
			{#each p.keep as o (o.key)}
				<li class="flex gap-2"><span class="text-foreground">{o.database}</span> <RelativeTime ms={o.createdAt} /> · {bytes(o.bytes)} · {o.reason}</li>
			{/each}
		</ul>
	{/if}
</div>
