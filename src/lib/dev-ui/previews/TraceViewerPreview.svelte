<!-- Renders <TraceBrowser> from a static span fixture (ADR 0054, 0077). -->
<script lang="ts">
	import TraceBrowser from '$lib/components/dev/trace/TraceBrowser.svelte';
	import { TRACE_FIXTURES, type TraceFixture } from '$lib/trace/fixtures';
	import { summarizeTraces } from '$lib/trace/summary';
	import type { Args } from '../types';

	let { args }: { args: Args } = $props();

	const all = $derived((TRACE_FIXTURES[(args.fixture as TraceFixture) ?? 'singleIssue'] ?? TRACE_FIXTURES.empty)());
	const traces = $derived(
		summarizeTraces(all, {
			limit: 100,
			...(args.address ? { address: String(args.address) } : {}),
			...(args.search ? { search: String(args.search) } : {})
		})
	);
	let selectedTraceId = $state<string | null>(null);
	// A new fixture starts on its richest trace (most spans), not the newest one.
	$effect(() => {
		void all;
		selectedTraceId = [...traces].sort((x, y) => y.spanCount - x.spanCount)[0]?.traceId ?? null;
	});
	const spans = $derived(selectedTraceId ? all.filter((s) => s.traceId === selectedTraceId) : null);
</script>

<div class="bg-card -mx-1 rounded-lg border py-3">
	<TraceBrowser
		{traces}
		{spans}
		bind:selectedTraceId
		ready={!args.loading}
		note="(static fixture)"
		onFilterAddress={args.filterable ? () => {} : undefined}
	/>
</div>
