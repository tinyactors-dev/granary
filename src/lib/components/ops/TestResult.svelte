<!-- Step-by-step test connection result plus the manual checklist (ADR 0095). -->
<script lang="ts">
	import type { TestConnectionResult } from '$lib/ops/contract';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import CircleMinusIcon from '@lucide/svelte/icons/circle-minus';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';

	let { result }: { result: TestConnectionResult } = $props();
</script>

<div class="grid gap-3 text-sm" data-testid="test-result" data-ok={result.ok}>
	<p class="font-medium">
		{#if result.ok}Connection works.{:else}Connection failed — see the first failing step.{/if}
	</p>
	{#if result.resolvedEndpoint}
		<p class="text-muted-foreground text-xs">Endpoint <code class="text-foreground">{result.resolvedEndpoint}</code></p>
	{/if}
	<ol class="grid gap-1">
		{#each result.steps as s, i (i)}
			<li class="flex items-start gap-2">
				{#if s.skipped}<CircleMinusIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
				{:else if s.ok}<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
				{:else}<CircleXIcon class="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />{/if}
				<span class="min-w-0 flex-1">
					{s.name}
					<span class="text-muted-foreground text-xs">
						{s.skipped ? 'skipped' : `${s.durationMs} ms`}{s.providerCode ? ` · ${s.providerCode}` : ''}
					</span>
					{#if s.detail}<span class="text-muted-foreground block text-xs">{s.detail}</span>{/if}
				</span>
			</li>
		{/each}
	</ol>
	{#if result.advisories.length}
		<div class="rounded-md border p-3">
			<p class="mb-2 flex items-center gap-2 font-medium"><ListChecksIcon class="size-4" /> Check these by hand</p>
			<ul class="grid gap-2">
				{#each result.advisories as a (a.title)}
					<li>
						<span class="font-medium">{a.title}.</span> <span class="text-muted-foreground">{a.detail}</span>
						{#if a.docsUrl}<a class="inline-flex items-center gap-0.5 text-xs underline" href={a.docsUrl} target="_blank" rel="noreferrer">docs <ExternalLinkIcon class="size-3" /></a>{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
