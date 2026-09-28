<!-- The chart's state tree with the active configuration highlighted (ADR 0056). -->
<script lang="ts">
	import type { ChartState, ChartStructure } from '$lib/schemas/api';

	let {
		chart,
		active,
		finalState = null
	}: { chart: ChartStructure; active: string[]; finalState?: string | null } = $props();

	const activeSet = $derived(new Set([...active, ...(finalState ? [finalState] : [])]));

	const KIND: Record<ChartState['kind'], string> = {
		atomic: '',
		compound: 'compound',
		parallel: 'parallel',
		final: 'final',
		history_shallow: 'history',
		history_deep: 'deep history'
	};

	function jump(id: string) {
		document.getElementById(`chart-state-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}
</script>

{#snippet targets(ts: string[])}
	{#each ts as t, i (t)}{#if i}, {/if}<button
			type="button"
			class="font-mono underline-offset-2 hover:underline {activeSet.has(t) ? 'text-primary font-semibold' : ''}"
			onclick={() => jump(t)}>{t}</button
		>{:else}<span class="text-muted-foreground">(targetless)</span>{/each}
{/snippet}

{#snippet stateNode(s: ChartState)}
	{@const on = activeSet.has(s.id)}
	<div
		id="chart-state-{s.id}"
		data-testid="chart-state"
		data-active={on}
		class="rounded-lg border {on ? 'border-primary bg-primary/5 ring-primary/30 ring-2' : 'bg-card'} {s.kind === 'final' ? 'border-double border-4' : ''} scroll-mt-24 p-3"
	>
		<div class="flex flex-wrap items-center gap-2">
			<span class="font-mono text-sm font-semibold">{s.id}</span>
			{#if KIND[s.kind]}<span class="bg-muted rounded px-1.5 text-[11px] leading-5">{KIND[s.kind]}</span>{/if}
			{#if on}<span class="bg-primary text-primary-foreground rounded px-1.5 text-[11px] leading-5">{s.id === finalState ? 'final' : 'active'}</span>{/if}
			{#if s.source}<span class="text-muted-foreground ml-auto font-mono text-[11px]">{s.source.file}:{s.source.line}</span>{/if}
		</div>
		{#if s.onentry.length || s.onexit.length || s.invokes.length || s.initial.length}
			<div class="text-muted-foreground mt-1.5 space-y-0.5 font-mono text-xs">
				{#if s.initial.length}<div>initial → {@render targets(s.initial)}</div>{/if}
				{#each s.onentry as a, i (i)}<div class="whitespace-pre"><span class="text-foreground/70">entry</span> {a}</div>{/each}
				{#each s.onexit as a, i (i)}<div class="whitespace-pre"><span class="text-foreground/70">exit</span> {a}</div>{/each}
				{#each s.invokes as a, i (i)}<div>{a}</div>{/each}
			</div>
		{/if}
		{#if s.transitions.length}
			<ul class="mt-2 space-y-1.5">
				{#each s.transitions as t, i (i)}
					<li class="border-muted-foreground/30 border-l-2 pl-2 text-xs">
						<div class="flex flex-wrap items-baseline gap-x-1.5">
							<span class="font-mono font-medium {t.event ? '' : 'text-muted-foreground italic'}">{t.event ?? 'always'}</span>
							{#if t.condition}<span class="text-amber-700 dark:text-amber-400 font-mono">[{t.condition}]</span>{/if}
							<span class="text-muted-foreground">→</span>
							{@render targets(t.targets)}
							{#if t.kind === 'internal'}<span class="text-muted-foreground">(internal)</span>{/if}
							{#if t.source}<span class="text-muted-foreground ml-auto font-mono text-[11px]">:{t.source.line}</span>{/if}
						</div>
						{#if t.actions.length}
							<div class="text-muted-foreground mt-0.5 font-mono whitespace-pre">{t.actions.join('\n')}</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if s.children.length}
			<div class="mt-3 grid gap-2 {s.kind === 'parallel' ? 'md:grid-cols-2' : ''}">
				{#each s.children as c (c.id)}{@render stateNode(c)}{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div class="space-y-2" data-testid="chart-tree">
	<div class="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
		<span>initial → {@render targets(chart.initial)}</span>
		<span>data: <span class="font-mono">{chart.data.join(', ') || '—'}</span></span>
		<span>datamodel: <span class="font-mono">{chart.datamodel}</span></span>
		<span>defined in <span class="font-mono">{chart.sourceFile}</span></span>
	</div>
	<div class="grid gap-2">
		{#each chart.states as s (s.id)}{@render stateNode(s)}{/each}
	</div>
</div>
