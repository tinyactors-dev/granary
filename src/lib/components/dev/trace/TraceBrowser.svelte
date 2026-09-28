<!--
  The presentational half of the trace explorer (ADR 0054): legend, trace
  list, and the selected trace's Jaeger-style timeline. It takes plain data,
  so the live explorer (remote queries) and the UI stories (static fixtures,
  /admin/ui/trace-viewer) render the same component. Selection and
  expansion state live here and survive data refreshes.
-->
<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import ChevronsDownUpIcon from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import LinkIcon from '@lucide/svelte/icons/link';
	import FilterIcon from '@lucide/svelte/icons/filter';
	import type { SpanSummary, TraceSummary } from '$lib/schemas/dev';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import TraceList from './TraceList.svelte';
	import TraceTimeline from './TraceTimeline.svelte';
	import { familyColor, LEGEND } from './colors';
	import { buildTree, formatDuration, parentKeys, shortName } from './tree';

	let {
		traces,
		spans,
		selectedTraceId = $bindable(null),
		ready = true,
		error = null,
		retry,
		note = '',
		onFilterAddress
	}: {
		/** Newest first. */
		traces: TraceSummary[];
		/** Spans of `selectedTraceId`; null while loading. */
		spans: SpanSummary[] | null;
		selectedTraceId?: string | null;
		ready?: boolean;
		error?: unknown;
		retry?: () => void;
		/** Shown at the right of the legend. */
		note?: string;
		/** Clicking an address chip; hidden when absent. */
		onFilterAddress?: (address: string) => void;
	} = $props();

	let selectedSpanId = $state<string | null>(null);
	/** Collapsed node keys of the selected trace. */
	const collapsed = new SvelteSet<string>();
	/** Span to reveal once the selected trace's spans arrive. */
	let pendingReveal: string | null = null;
	let timeline = $state<ReturnType<typeof TraceTimeline>>();

	const selectedSummary = $derived(traces.find((t) => t.traceId === selectedTraceId) ?? null);

	// Pick the newest trace when nothing is selected yet.
	$effect(() => {
		if (selectedTraceId === null && traces.length) selectTrace(traces[0]!.traceId);
	});

	// Reveal a span requested by navigation once its trace is loaded.
	$effect(() => {
		if (pendingReveal && spans?.some((s) => s.spanId === pendingReveal) && timeline) {
			const id = pendingReveal;
			pendingReveal = null;
			timeline.reveal(id);
		}
	});

	function selectTrace(traceId: string, spanId: string | null = null) {
		if (traceId !== selectedTraceId) {
			selectedTraceId = traceId;
			selectedSpanId = null;
			collapsed.clear();
		}
		if (spanId) pendingReveal = spanId;
	}

	function navigate(traceId: string | null, spanId: string | null) {
		if (traceId && traceId !== selectedTraceId) selectTrace(traceId, spanId);
		else if (spanId) timeline?.reveal(spanId);
	}

	function expandAll() {
		collapsed.clear();
	}
	function collapseAll() {
		if (!spans) return;
		for (const k of parentKeys(buildTree(spans))) collapsed.add(k);
	}
	const familyOf = (a: string) => a.split('/')[0];
	const time = (ms: number) =>
		new Date(ms).toLocaleString('en', { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
</script>

<div class="trace-root space-y-3" data-testid="trace-browser">
	<!-- legend -->
	<div class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 px-6 text-xs" aria-label="Legend">
		{#each LEGEND as l (l.label)}
			<span class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm" style:background={l.color}></span>{l.label}</span>
		{/each}
		<span class="flex items-center gap-1.5"><span class="h-2.5 w-[3px] rounded-sm bg-[var(--trace-error)]"></span>error</span>
		<span class="ml-auto">{traces.length} trace{traces.length === 1 ? '' : 's'}{note ? ` ${note}` : ''}</span>
	</div>

	{#if error && !traces.length}
		<div class="px-6"><ErrorAlert {error} {retry} /></div>
	{:else if !ready}
		<div class="space-y-2 px-6">
			{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-8 w-full" />{/each}
		</div>
	{:else if traces.length === 0}
		<p class="text-muted-foreground border-y px-6 py-10 text-center text-sm" data-testid="trace-empty">
			No traces yet — they appear as soon as an actor handles an event.
		</p>
	{:else}
		<TraceList {traces} selected={selectedTraceId} onSelect={(id) => selectTrace(id)} />
	{/if}

	{#if selectedTraceId && traces.length}
		<section class="space-y-2" aria-label="Trace" data-testid="trace-view">
			<div class="flex flex-wrap items-start gap-x-6 gap-y-2 px-6 pt-2">
				<div class="min-w-0">
					<h3 class="font-mono text-sm font-semibold">
						{selectedSummary ? shortName(selectedSummary.rootName) : 'trace'}
						{#if selectedSummary?.rootAddress}<span class="text-muted-foreground font-normal"> · {selectedSummary.rootAddress}</span>{/if}
					</h3>
					<div class="text-muted-foreground flex items-center gap-1 font-mono text-xs">
						{selectedTraceId}<CopyButton text={selectedTraceId} label="Copy trace id" />
					</div>
				</div>
				{#if selectedSummary}
					<dl class="flex flex-wrap gap-x-5 gap-y-1 text-xs">
						<div><dt class="text-muted-foreground inline">Start</dt> <dd class="inline font-mono">{time(selectedSummary.start)}</dd></div>
						<div><dt class="text-muted-foreground inline">Duration</dt> <dd class="inline font-mono">{formatDuration(selectedSummary.durationMs)}</dd></div>
						<div><dt class="text-muted-foreground inline">Spans</dt> <dd class="inline font-mono">{selectedSummary.spanCount}</dd></div>
						<div><dt class="text-muted-foreground inline">Services</dt> <dd class="inline font-mono">{selectedSummary.services.join(', ') || '—'}</dd></div>
						{#if selectedSummary.orphanCount}
							<div title="Spans whose parent is not in the buffer"><dt class="text-muted-foreground inline">Orphans</dt> <dd class="inline font-mono">{selectedSummary.orphanCount}</dd></div>
						{/if}
					</dl>
				{/if}
				<div class="ml-auto flex gap-1">
					<Button variant="ghost" size="sm" onclick={expandAll}><ChevronsUpDownIcon /> Expand all</Button>
					<Button variant="ghost" size="sm" onclick={collapseAll}><ChevronsDownUpIcon /> Collapse all</Button>
				</div>
			</div>

			{#if selectedSummary && (selectedSummary.addresses.length || selectedSummary.linkedTraceIds.length)}
				<div class="flex flex-wrap items-center gap-2 px-6 text-xs">
					{#each selectedSummary.addresses as a (a)}
						{#if onFilterAddress}
							<button
								class="hover:bg-muted inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono"
								title="Show every trace touching {a}"
								onclick={() => onFilterAddress(a)}
								data-testid="address-chip"
							>
								<span class="size-2 rounded-sm" style:background={familyColor(familyOf(a))}></span>{a}
								<FilterIcon class="text-muted-foreground size-3" />
							</button>
						{:else}
							<span class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono" data-testid="address-chip">
								<span class="size-2 rounded-sm" style:background={familyColor(familyOf(a))}></span>{a}
							</span>
						{/if}
					{/each}
					{#each selectedSummary.linkedTraceIds as id (id)}
						<button
							class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-sky-700 hover:underline dark:text-sky-400"
							onclick={() => selectTrace(id)}
							data-testid="linked-trace"
						>
							<LinkIcon class="size-3" /> linked {id.slice(0, 12)}…
						</button>
					{/each}
				</div>
			{/if}

			{#if spans === null}
				<div class="space-y-1 px-6">
					{#each [0, 1, 2, 3, 4] as i (i)}<Skeleton class="h-6 w-full" />{/each}
				</div>
			{:else if spans.length === 0}
				<p class="text-muted-foreground px-6 py-6 text-center text-sm">This trace is no longer in the buffer.</p>
			{:else}
				<TraceTimeline bind:this={timeline} {spans} {collapsed} bind:selectedSpanId onNavigate={navigate} />
			{/if}
		</section>
	{/if}
</div>

<style>
	/* Categorical slots 1–3 of the reference palette (validated all-pairs,
	   light + dark); error is the reserved status red; neutral for no actor. */
	.trace-root {
		--trace-1: #2a78d6;
		--trace-2: #eb6834;
		--trace-3: #1baf7a;
		--trace-none: #8a8984;
		--trace-error: #d03b3b;
	}
	:global(.dark .trace-root:not(.theme-light .trace-root)) {
		--trace-1: #3987e5;
		--trace-2: #d95926;
		--trace-3: #199e70;
		--trace-none: #6f6e69;
		--trace-error: #d03b3b;
	}
</style>
