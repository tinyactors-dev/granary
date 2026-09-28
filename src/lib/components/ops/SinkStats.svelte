<!-- Throughput, drops, buffer and circuit state of one sink (ADR 0085, 0107). -->
<script lang="ts">
	import type { OpsStatus, TelemetryStats } from '$lib/ops/contract';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import { SINK_STATE_LABELS } from '$lib/components/app/glossary';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import Meter from './Meter.svelte';
	import { bytes, duration, percent } from './format';

	let { stats, state }: { stats: TelemetryStats; state: OpsStatus['telemetry'][number] | undefined } = $props();
	const tiles = $derived([
		{ label: 'Sent', value: `${stats.sentBatches.toLocaleString('en')} batches`, sub: bytes(stats.sentBytes) },
		{ label: 'Dropped', value: `${stats.droppedBatches.toLocaleString('en')} batches`, sub: bytes(stats.droppedBytes) },
		{ label: 'Buffered now', value: bytes(stats.bufferedBytes), sub: 'waiting to send' },
		{ label: 'Trace sampling', value: percent(stats.sampleRatio), sub: stats.sampleRatio < 1 ? 'lowered to stay under the cap' : 'everything kept' }
	]);
</script>

<div class="grid gap-4" data-testid="sink-stats">
	<div class="flex flex-wrap items-center gap-2 text-sm">
		<span class="text-muted-foreground">Connection</span>
		<StateBadge state={state?.state ?? 'unknown'} label={SINK_STATE_LABELS[state?.state ?? 'unknown']} tone={state?.state === 'open' ? 'warning' : state?.state === 'disabled' ? 'muted' : 'success'} />
		<span class="text-muted-foreground">last export <RelativeTime ms={state?.lastSuccessAt} /> · window {duration(stats.windowMs)}</span>
	</div>
	<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		{#each tiles as t (t.label)}
			<div class="rounded-lg border p-3">
				<dt class="text-muted-foreground text-xs">{t.label}</dt>
				<dd class="mt-1 font-semibold">{t.value}</dd>
				<dd class="text-muted-foreground text-xs">{t.sub}</dd>
			</div>
		{/each}
	</dl>
	<Meter label="Volume this month" value={stats.volumeThisMonthBytes} max={stats.volumeBudgetBytes} format={bytes} />
	{#if stats.lastError}<p class="text-sm"><span class="text-muted-foreground">Last error:</span> {stats.lastError}</p>{/if}
</div>
