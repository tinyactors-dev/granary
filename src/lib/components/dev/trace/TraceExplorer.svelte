<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ChevronsDownUpIcon from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import LinkIcon from '@lucide/svelte/icons/link';
	import FilterIcon from '@lucide/svelte/icons/filter';
	import XIcon from '@lucide/svelte/icons/x';
	import { getRecentSpans, listRecentTraces } from '$lib/remote/dev.remote';
	import { SPAN_BUFFER_SIZE } from '$lib/schemas/dev';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import NativeSelect from '../NativeSelect.svelte';
	import TraceList from './TraceList.svelte';
	import TraceTimeline from './TraceTimeline.svelte';
	import { familyColor, LEGEND } from './colors';
	import { buildTree, formatDuration, parentKeys, shortName } from './tree';

	// -- filters (text inputs debounced) ---------------------------------------
	let family = $state('');
	let addressInput = $state('');
	let searchInput = $state('');
	let address = $state('');
	let search = $state('');
	$effect(() => {
		const a = addressInput.trim();
		const s = searchInput.trim();
		const id = setTimeout(() => {
			address = a;
			search = s;
		}, 250);
		return () => clearTimeout(id);
	});

	let auto = $state(true);

	// -- selection state survives refreshes (keyed by ids) ---------------------
	let selectedTraceId = $state<string | null>(null);
	let selectedSpanId = $state<string | null>(null);
	/** Collapsed node keys of the selected trace. */
	const collapsed = new SvelteSet<string>();
	/** Span to reveal once the selected trace's spans arrive. */
	let pendingReveal: string | null = null;
	let timeline = $state<ReturnType<typeof TraceTimeline>>();

	const traces = $derived(
		listRecentTraces({
			limit: 100,
			...(family ? { family } : {}),
			...(address ? { address } : {}),
			...(search ? { search } : {})
		})
	);
	const spansQuery = $derived(selectedTraceId ? getRecentSpans({ traceId: selectedTraceId, limit: SPAN_BUFFER_SIZE }) : null);

	const traceList = $derived(traces.current ?? []);
	const selectedSummary = $derived(traceList.find((t) => t.traceId === selectedTraceId) ?? null);
	const spans = $derived(spansQuery?.current ?? null);

	// Pick the newest trace when nothing is selected yet.
	$effect(() => {
		if (selectedTraceId === null && traceList.length) selectTrace(traceList[0]!.traceId);
	});

	// Reveal a span requested by navigation once its trace is loaded.
	$effect(() => {
		if (pendingReveal && spans?.some((s) => s.spanId === pendingReveal) && timeline) {
			const id = pendingReveal;
			pendingReveal = null;
			timeline.reveal(id);
		}
	});

	$effect(() => {
		if (!auto) return;
		const q = traces;
		const s = spansQuery;
		const id = setInterval(() => {
			void q.refresh();
			void s?.refresh();
		}, 2000);
		return () => clearInterval(id);
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
	function refresh() {
		void traces.refresh();
		void spansQuery?.refresh();
	}
	const familyOf = (a: string) => a.split('/')[0];
	const time = (ms: number) =>
		new Date(ms).toLocaleString('en', { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
</script>

<div class="trace-root space-y-3" data-testid="trace-explorer">
	<!-- filters: one row above the views -->
	<div class="flex flex-wrap items-center gap-2 px-6">
		<FilterIcon class="text-muted-foreground size-4" />
		<NativeSelect bind:value={family} class="h-8 w-36" aria-label="Actor family">
			<option value="">all families</option>
			<option value="issue">issue</option>
			<option value="allowlist">allowlist</option>
		</NativeSelect>
		<div class="relative">
			<Input bind:value={addressInput} placeholder="actor address…" class="h-8 w-48 pr-7 font-mono text-xs" aria-label="Actor address" />
			{#if addressInput}
				<button class="text-muted-foreground absolute top-1/2 right-2 -translate-y-1/2" aria-label="Clear address filter" onclick={() => (addressInput = '')}><XIcon class="size-3.5" /></button>
			{/if}
		</div>
		<Input bind:value={searchInput} placeholder="event / span name…" class="h-8 w-48 font-mono text-xs" aria-label="Search events" />
		<div class="ml-auto flex items-center gap-3">
			<div class="flex items-center gap-2">
				<Switch id="traces-auto" bind:checked={auto} />
				<Label for="traces-auto" class="text-sm">Live (2 s)</Label>
			</div>
			<Button variant="outline" size="sm" onclick={refresh}>
				<RefreshCwIcon class={traces.loading ? 'animate-spin' : ''} /> Refresh
			</Button>
		</div>
	</div>

	<!-- legend -->
	<div class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 px-6 text-xs" aria-label="Legend">
		{#each LEGEND as l (l.label)}
			<span class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm" style:background={l.color}></span>{l.label}</span>
		{/each}
		<span class="flex items-center gap-1.5"><span class="h-2.5 w-[3px] rounded-sm bg-[var(--trace-error)]"></span>error</span>
		<span class="ml-auto">{traceList.length} trace{traceList.length === 1 ? '' : 's'} in the buffer (last {SPAN_BUFFER_SIZE} spans)</span>
	</div>

	{#if traces.error && !traces.current}
		<div class="px-6"><ErrorAlert error={traces.error} retry={refresh} /></div>
	{:else if !traces.ready}
		<div class="space-y-2 px-6">
			{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-8 w-full" />{/each}
		</div>
	{:else}
		<TraceList traces={traceList} selected={selectedTraceId} onSelect={(id) => selectTrace(id)} />
	{/if}

	{#if selectedTraceId}
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
						<button
							class="hover:bg-muted inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono"
							title="Show every trace touching {a}"
							onclick={() => (addressInput = a)}
							data-testid="address-chip"
						>
							<span class="size-2 rounded-sm" style:background={familyColor(familyOf(a))}></span>{a}
							<FilterIcon class="text-muted-foreground size-3" />
						</button>
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
	:global(.dark) .trace-root {
		--trace-1: #3987e5;
		--trace-2: #d95926;
		--trace-3: #199e70;
		--trace-none: #6f6e69;
		--trace-error: #d03b3b;
	}
</style>
