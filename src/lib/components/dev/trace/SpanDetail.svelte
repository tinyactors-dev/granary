<script lang="ts">
	import type { SpanSummary } from '$lib/schemas/dev';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import { prettyJson } from '$lib/components/app/format';
	import LinkIcon from '@lucide/svelte/icons/link';
	import CornerUpLeftIcon from '@lucide/svelte/icons/corner-up-left';
	import { displayValue, formatDuration } from './tree';

	let {
		span,
		traceStart,
		inTrace,
		onNavigate
	}: {
		span: SpanSummary;
		traceStart: number;
		/** Is this span id part of the trace being shown? */
		inTrace: (spanId: string) => boolean;
		/** Jump to a span, in this trace (traceId null) or another one. */
		onNavigate: (traceId: string | null, spanId: string | null) => void;
	} = $props();

	const attrs = $derived(Object.entries(span.attributes).sort(([a], [b]) => a.localeCompare(b)));
	const offset = (t: number) => formatDuration(t - traceStart);
	const causeHere = $derived(span.cause ? inTrace(span.cause.spanId) : false);
</script>

<div class="bg-muted/30 space-y-4 border-y px-4 py-3 text-xs" data-testid="span-detail">
	<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
		<span class="font-mono text-sm font-medium">{span.name}</span>
		<span class="text-muted-foreground">service <span class="text-foreground font-mono">{span.service ?? '—'}</span></span>
		<span class="text-muted-foreground">duration <span class="text-foreground font-mono">{formatDuration(span.durationMs)}</span></span>
		<span class="text-muted-foreground">start <span class="text-foreground font-mono">+{offset(span.start)}</span></span>
		<span class="text-muted-foreground">kind <span class="text-foreground font-mono">{span.kind}</span></span>
		<StateBadge
			state={span.status.code}
			tone={span.status.code === 'error' ? 'danger' : span.status.code === 'ok' ? 'success' : 'muted'}
		/>
		{#if span.status.message}<span class="text-red-700 dark:text-red-400">{span.status.message}</span>{/if}
	</div>

	<dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 font-mono">
		<dt class="text-muted-foreground font-sans">Trace</dt>
		<dd class="flex items-center gap-1 break-all">{span.traceId}<CopyButton text={span.traceId} label="Copy trace id" /></dd>
		<dt class="text-muted-foreground font-sans">Span</dt>
		<dd class="flex items-center gap-1 break-all">{span.spanId}<CopyButton text={span.spanId} label="Copy span id" /></dd>
		<dt class="text-muted-foreground font-sans">Parent</dt>
		<dd class="break-all">
			{#if !span.parentSpanId}
				<span class="text-muted-foreground font-sans">none (root)</span>
			{:else if inTrace(span.parentSpanId)}
				<button class="text-sky-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-sky-400" onclick={() => onNavigate(null, span.parentSpanId)}>{span.parentSpanId}</button>
			{:else}
				{span.parentSpanId} <span class="text-muted-foreground font-sans">(not in the buffer / never emitted)</span>
			{/if}
		</dd>
		{#if span.cause}
			<dt class="text-muted-foreground font-sans">Caused by</dt>
			<dd class="flex flex-wrap items-center gap-1 break-all">
				<CornerUpLeftIcon class="size-3.5" />
				{#if causeHere}
					<button class="text-sky-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-sky-400" onclick={() => onNavigate(null, span.cause!.spanId)}>{span.cause.spanId}</button>
					<span class="text-muted-foreground font-sans">(this trace)</span>
				{:else if span.cause.traceId}
					<button
						class="text-sky-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-sky-400"
						onclick={() => onNavigate(span.cause!.traceId, span.cause!.spanId)}
						data-testid="cause-link">{span.cause.spanId} in trace {span.cause.traceId.slice(0, 12)}…</button
					>
				{:else}
					{span.cause.spanId} <span class="text-muted-foreground font-sans">(not in the buffer)</span>
				{/if}
			</dd>
		{/if}
	</dl>

	<section>
		<h4 class="mb-1 font-sans text-xs font-medium">Attributes ({attrs.length})</h4>
		<div class="overflow-hidden rounded-md border">
			<table class="w-full border-collapse">
				<tbody>
					{#each attrs as [key, raw] (key)}
						{@const v = displayValue(raw)}
						<tr class="even:bg-muted/40 align-top">
							<td class="text-muted-foreground w-[1%] py-1 pr-3 pl-2 font-mono whitespace-nowrap">{key}</td>
							<td class="py-1 pr-2 font-mono break-all">
								{#if v.json}
									<pre class="whitespace-pre-wrap">{prettyJson(v.value)}</pre>
								{:else}
									{String(v.value)}
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	{#if span.events.length}
		<section>
			<h4 class="mb-1 font-sans text-xs font-medium">Events ({span.events.length})</h4>
			<ul class="space-y-1">
				{#each span.events as e, i (i)}
					<li class="rounded-md border px-2 py-1">
						<span class="font-mono">+{offset(e.time)}</span>
						<span class="ml-2 font-mono font-medium">{e.name}</span>
						{#each Object.entries(e.attributes) as [k, raw] (k)}
							{@const v = displayValue(raw)}
							<span class="text-muted-foreground ml-3 font-mono">{k}=</span><span class="font-mono">{v.json ? JSON.stringify(v.value) : String(v.value)}</span>
						{/each}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if span.links.length}
		<section>
			<h4 class="mb-1 font-sans text-xs font-medium">Links ({span.links.length})</h4>
			<ul class="space-y-1">
				{#each span.links as l, i (i)}
					<li class="flex flex-wrap items-center gap-2 font-mono">
						<LinkIcon class="size-3.5" />
						<button
							class="text-sky-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-sky-400"
							onclick={() => onNavigate(l.traceId === span.traceId ? null : l.traceId, l.spanId)}
							data-testid="span-link">trace {l.traceId.slice(0, 12)}… / span {l.spanId}</button
						>
						{#if Object.keys(l.attributes).length}<span class="text-muted-foreground">{JSON.stringify(l.attributes)}</span>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
