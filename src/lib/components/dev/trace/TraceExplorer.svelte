<!--
  The live trace explorer (ADR 0054): filters and polling over the app's
  trace buffer (remote queries), rendered by <TraceBrowser>.
-->
<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import FilterIcon from '@lucide/svelte/icons/filter';
	import XIcon from '@lucide/svelte/icons/x';
	import { getRecentSpans, listRecentTraces } from '$lib/remote/dev.remote';
	import { SPAN_BUFFER_SIZE } from '$lib/schemas/dev';
	import NativeSelect from '../NativeSelect.svelte';
	import TraceBrowser from './TraceBrowser.svelte';

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
	// The viewer polls every 2 s; its own requests would flood the list, so they're hidden by default.
	let showOwn = $state(false);
	const OWN = /^(GET|POST) (remote:(listRecentTraces|getRecentSpans)|\/admin\/traces)$/;
	let selectedTraceId = $state<string | null>(null);

	const traces = $derived(
		listRecentTraces({
			limit: 100,
			...(family ? { family } : {}),
			...(address ? { address } : {}),
			...(search ? { search } : {})
		})
	);
	const spansQuery = $derived(selectedTraceId ? getRecentSpans({ traceId: selectedTraceId, limit: SPAN_BUFFER_SIZE }) : null);

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

	function refresh() {
		void traces.refresh();
		void spansQuery?.refresh();
	}
</script>

<div class="space-y-3" data-testid="trace-explorer">
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
				<Switch id="traces-own" bind:checked={showOwn} />
				<Label for="traces-own" class="text-sm">Show this page's own requests</Label>
			</div>
			<div class="flex items-center gap-2">
				<Switch id="traces-auto" bind:checked={auto} />
				<Label for="traces-auto" class="text-sm">Live (2 s)</Label>
			</div>
			<Button variant="outline" size="sm" onclick={refresh}>
				<RefreshCwIcon class={traces.loading ? 'animate-spin' : ''} /> Refresh
			</Button>
		</div>
	</div>

	<TraceBrowser
		traces={(traces.current ?? []).filter((t) => showOwn || !OWN.test(t.rootName))}
		spans={spansQuery?.current ?? null}
		bind:selectedTraceId
		ready={traces.ready}
		error={traces.error}
		retry={refresh}
		note="in the buffer (last {SPAN_BUFFER_SIZE} spans)"
		onFilterAddress={(a) => (addressInput = a)}
	/>
</div>
