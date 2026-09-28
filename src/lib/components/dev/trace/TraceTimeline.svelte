<script lang="ts">
	import type { SpanSummary } from '$lib/schemas/dev';
	import type { SvelteSet } from 'svelte/reactivity';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import UnlinkIcon from '@lucide/svelte/icons/unlink';
	import SpanDetail from './SpanDetail.svelte';
	import { familyColor } from './colors';
	import { ATTR, buildTree, flatten, formatDuration, shortName, spanHint, ticks } from './tree';

	let {
		spans,
		collapsed,
		selectedSpanId = $bindable(null),
		onNavigate
	}: {
		spans: SpanSummary[];
		collapsed: SvelteSet<string>;
		selectedSpanId?: string | null;
		onNavigate: (traceId: string | null, spanId: string | null) => void;
	} = $props();

	const roots = $derived(buildTree(spans));
	const rows = $derived(flatten(roots, collapsed));
	const ids = $derived(new Set(spans.map((s) => s.spanId)));
	const t0 = $derived(spans.length ? Math.min(...spans.map((s) => s.start)) : 0);
	const t1 = $derived(spans.length ? Math.max(...spans.map((s) => s.end)) : 0);
	const total = $derived(Math.max(t1 - t0, 0.001));
	const axis = $derived(ticks(total));

	const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;

	function toggle(key: string) {
		if (collapsed.has(key)) collapsed.delete(key);
		else collapsed.add(key);
	}

	function select(spanId: string) {
		selectedSpanId = selectedSpanId === spanId ? null : spanId;
	}

	/** Uncollapse every ancestor of `spanId` so it is visible (used by navigation). */
	export function reveal(spanId: string) {
		const byId = new Map(spans.map((s) => [s.spanId, s]));
		let p = byId.get(spanId)?.parentSpanId ?? null;
		const seen = new Set<string>();
		while (p && !seen.has(p)) {
			seen.add(p);
			collapsed.delete(p);
			collapsed.delete(`missing:${p}`);
			p = byId.get(p)?.parentSpanId ?? null;
		}
		selectedSpanId = spanId;
		queueMicrotask(() =>
			document.querySelector(`[data-span-row="${spanId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
		);
	}

	const NAME_COL = 'w-[42%] min-w-[260px]';
</script>

<div class="overflow-x-auto" data-testid="trace-timeline">
	<div class="min-w-[720px]">
		<!-- time axis -->
		<div class="bg-muted/40 sticky top-0 z-10 flex border-b text-[11px]">
			<div class="{NAME_COL} text-muted-foreground shrink-0 px-3 py-1.5 font-medium">Span</div>
			<div class="relative h-7 flex-1 border-l">
				{#each axis as t, i (i)}
					<div class="absolute inset-y-0 border-l border-dashed border-current/15" style:left={pct(t)}></div>
					<span
						class="text-muted-foreground absolute top-1.5 font-mono whitespace-nowrap"
						style:left={pct(t)}
						style:transform={t / total > 0.9 ? 'translateX(calc(-100% - 4px))' : 'translateX(4px)'}>{formatDuration(t)}</span
					>
				{/each}
			</div>
		</div>

		{#each rows as row (row.node.key)}
			{@const n = row.node}
			{@const s = n.span}
			{@const isOpen = !collapsed.has(n.key)}
			{@const selected = s !== null && s.spanId === selectedSpanId}
			{@const error = s?.status.code === 'error'}
			{@const color = s ? familyColor(s.attributes[ATTR.family]) : 'var(--trace-none)'}
			<div
				class="group flex border-b text-xs {selected ? 'bg-accent' : 'hover:bg-muted/50'} {error ? 'shadow-[inset_3px_0_0_var(--trace-error)]' : ''}"
				data-span-row={s?.spanId ?? n.key}
				data-testid="trace-row"
			>
				<!-- name column -->
				<div class="{NAME_COL} flex shrink-0 items-center gap-1 py-1 pr-2" style:padding-left="{8 + row.depth * 16}px">
					{#if n.children.length}
						<button
							class="hover:bg-muted rounded p-0.5"
							aria-label={isOpen ? 'Collapse' : 'Expand'}
							aria-expanded={isOpen}
							onclick={() => toggle(n.key)}
						>
							<ChevronRightIcon class="size-3.5 transition-transform {isOpen ? 'rotate-90' : ''}" />
						</button>
					{:else}
						<span class="w-[18px] shrink-0"></span>
					{/if}
					{#if s}
						<button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" onclick={() => select(s.spanId)} title="{s.name} · {s.attributes[ATTR.address] ?? 'no actor'}" data-testid="trace-row-name">
							<span class="size-2.5 shrink-0 rounded-sm" style:background={color}></span>
							{#if error}<CircleAlertIcon class="size-3.5 shrink-0 text-[var(--trace-error)]" aria-label="error" />{/if}
							<span class="truncate font-mono">{shortName(s.name)}</span>
							{#if typeof s.attributes[ATTR.address] === 'string'}
								<span class="text-muted-foreground truncate">{s.attributes[ATTR.address]}</span>
							{/if}
							{#if spanHint(s)}
								<span class="text-muted-foreground shrink-0 font-mono">{spanHint(s)}</span>
							{/if}
							{#if !isOpen && n.size}<span class="bg-muted shrink-0 rounded px-1 font-mono text-[10px]">+{n.size}</span>{/if}
						</button>
					{:else}
						<span class="text-muted-foreground flex items-center gap-1.5 italic" title="Parent span {n.missingId} is not in the buffer (evicted, in another process, or a step that is never emitted as a span)">
							<UnlinkIcon class="size-3.5" /> missing parent <span class="font-mono not-italic">{n.missingId?.slice(0, 8)}…</span>
							<span class="bg-muted rounded px-1 font-mono text-[10px] not-italic">{n.size}</span>
						</span>
					{/if}
				</div>

				<!-- bar column -->
				<button
					class="relative flex-1 cursor-pointer border-l"
					onclick={() => s && select(s.spanId)}
					tabindex="-1"
					title={s ? `${s.name}\n${formatDuration(s.durationMs)} at +${formatDuration(s.start - t0)}` : `missing parent ${n.missingId}`}
				>
					{#each axis as t, i (i)}
						<span class="absolute inset-y-0 border-l border-dashed border-current/5" style:left={pct(t)}></span>
					{/each}
					{#if s}
						{@const left = (s.start - t0) / total}
						{@const endFrac = (s.start - t0 + s.durationMs) / total}
						{@const labelAt = endFrac <= 0.85 ? 'after' : left >= 0.15 ? 'before' : 'inside'}
						<span
							class="absolute top-1/2 h-3 min-w-[2px] -translate-y-1/2 rounded-sm"
							style:left={pct(s.start - t0)}
							style:width={pct(s.durationMs)}
							style:background={error ? 'var(--trace-error)' : color}
						></span>
						<span
							class="absolute top-1/2 -translate-y-1/2 font-mono text-[10px] whitespace-nowrap {labelAt === 'inside' ? 'text-white' : 'text-muted-foreground'}"
							style:left={labelAt === 'after' ? `calc(${pct(s.start - t0 + s.durationMs)} + 6px)` : labelAt === 'inside' ? `calc(${pct(s.start - t0)} + 6px)` : 'auto'}
							style:right={labelAt === 'before' ? `calc(${100 - left * 100}% + 6px)` : 'auto'}>{formatDuration(s.durationMs)}</span
						>
					{:else}
						<span
							class="absolute top-1/2 h-px -translate-y-1/2 border-t border-dashed border-current/40"
							style:left={pct(n.start - t0)}
							style:width={pct(Math.max(n.end - n.start, 0))}
						></span>
					{/if}
				</button>
			</div>
			{#if selected && s}
				<SpanDetail span={s} traceStart={t0} inTrace={(id) => ids.has(id)} {onNavigate} />
			{/if}
		{/each}
	</div>
</div>
