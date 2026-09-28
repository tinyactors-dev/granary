<script lang="ts">
	import type { Args } from '../types';
	let { args: _args }: { args: Args } = $props();
</script>

<div class="space-y-2 text-sm">
	<p>
		The Jaeger-style trace viewer (ADR 0054). <code class="font-mono">&lt;TraceBrowser&gt;</code> is presentational: it takes
		trace summaries (<code class="font-mono">summarizeTraces</code> from <code class="font-mono">$lib/trace/summary</code>) and the
		spans of the selected trace, and keeps selection and expansion state across refreshes. The live
		<code class="font-mono">&lt;TraceExplorer&gt;</code> on <a class="underline" href="/__dev/traces">/__dev/traces</a> wraps it with filters and polling.
	</p>
	<pre class="bg-muted overflow-auto rounded-md p-3 font-mono text-xs">{`<TraceBrowser traces={summaries} spans={spansOfSelected}
  bind:selectedTraceId onFilterAddress={(a) => (address = a)} />`}</pre>
	<p class="text-muted-foreground text-xs">
		Stories use deterministic fixtures from <code class="font-mono">$lib/trace/fixtures</code> (also the stub backend's data): click a trace,
		expand/collapse the tree, click a span for attributes, events, links and cause.
	</p>
</div>
