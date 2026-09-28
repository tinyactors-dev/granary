<!-- /__dev/ui (ADR 0077): the component catalogue. -->
<script lang="ts">
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import { PREVIEWS } from '$lib/dev-ui/registry';
</script>

<PageHeader title="UI" description="Component previews: stories, controls and usage notes. Add one in src/lib/dev-ui/registry.ts." />

<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
	{#each PREVIEWS as p (p.id)}
		<a href="/__dev/ui/{p.id}" class="bg-card hover:border-primary/40 rounded-lg border p-4 transition-colors" data-testid="ui-entry">
			<div class="font-medium">{p.title}</div>
			<p class="text-muted-foreground mt-1 text-sm">{p.description}</p>
			<div class="text-muted-foreground mt-3 flex flex-wrap gap-1 text-xs">
				{#each p.stories as s (s.id)}<span class="bg-muted rounded px-1.5 py-0.5">{s.title}</span>{/each}
			</div>
			<div class="text-muted-foreground mt-2 font-mono text-[11px]">{p.source}</div>
		</a>
	{/each}
</div>
