<script lang="ts">
	import type { TraceSummary } from '$lib/schemas/dev';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import LinkIcon from '@lucide/svelte/icons/link';
	import { familyColor } from './colors';
	import { formatDuration, shortName } from './tree';

	let {
		traces,
		selected,
		onSelect
	}: { traces: TraceSummary[]; selected: string | null; onSelect: (traceId: string) => void } = $props();

	const time = (ms: number) =>
		new Date(ms).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
	const familyOf = (address: string) => address.split('/')[0];
</script>

<div class="max-h-80 overflow-auto border-y" data-testid="trace-list">
	<table class="w-full border-collapse text-xs">
		<thead class="bg-muted/60 text-muted-foreground sticky top-0 z-10 text-left">
			<tr>
				<th class="px-3 py-1.5 font-medium">Start</th>
				<th class="px-3 py-1.5 font-medium">Trace</th>
				<th class="px-3 py-1.5 font-medium">Actors</th>
				<th class="px-3 py-1.5 font-medium">Events</th>
				<th class="px-3 py-1.5 text-right font-medium">Spans</th>
				<th class="px-3 py-1.5 text-right font-medium">Duration</th>
			</tr>
		</thead>
		<tbody>
			{#each traces as t (t.traceId)}
				<tr
					class="cursor-pointer border-t align-top {t.traceId === selected ? 'bg-accent' : 'hover:bg-muted/50'} {t.errorCount ? 'shadow-[inset_3px_0_0_var(--trace-error)]' : ''}"
					onclick={() => onSelect(t.traceId)}
					data-testid="trace-list-row"
					aria-selected={t.traceId === selected}
				>
					<td class="text-muted-foreground px-3 py-1.5 font-mono whitespace-nowrap">{time(t.start)}</td>
					<td class="px-3 py-1.5">
						<div class="flex items-center gap-1.5">
							{#if t.errorCount}
								<CircleAlertIcon class="size-3.5 shrink-0 text-[var(--trace-error)]" aria-label="{t.errorCount} error spans" />
							{/if}
							<span class="font-mono font-medium">{shortName(t.rootName)}</span>
							{#if t.linkedTraceIds.length}
								<span class="text-muted-foreground flex items-center gap-0.5" title="Linked to {t.linkedTraceIds.length} other trace(s)">
									<LinkIcon class="size-3" />{t.linkedTraceIds.length}
								</span>
							{/if}
						</div>
						<div class="text-muted-foreground font-mono text-[10px]">{t.traceId.slice(0, 16)}… · {t.services.join(', ') || '—'}</div>
					</td>
					<td class="px-3 py-1.5">
						<div class="flex flex-wrap gap-1">
							{#each t.addresses as a (a)}
								<span class="inline-flex items-center gap-1 rounded border px-1 font-mono text-[10px]">
									<span class="size-2 rounded-sm" style:background={familyColor(familyOf(a))}></span>{a}
								</span>
							{:else}
								<span class="text-muted-foreground">—</span>
							{/each}
						</div>
					</td>
					<td class="text-muted-foreground max-w-[220px] px-3 py-1.5 font-mono text-[10px]">{t.events.join(' → ') || '—'}</td>
					<td class="px-3 py-1.5 text-right font-mono">
						{t.spanCount}{#if t.errorCount}<span class="text-[var(--trace-error)]"> · {t.errorCount} err</span>{/if}
					</td>
					<td class="px-3 py-1.5 text-right font-mono whitespace-nowrap">{formatDuration(t.durationMs)}</td>
				</tr>
			{:else}
				<tr>
					<td colspan="6" class="text-muted-foreground py-8 text-center">No traces match.</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
