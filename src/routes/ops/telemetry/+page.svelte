<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { isAdmin } from '$lib/components/app/session';
	import SinkStats from '$lib/components/ops/SinkStats.svelte';
	import { AUTH_LABEL } from '$lib/components/ops/format';
	import { getOpsSinkStats, getOpsStatus, listOpsSinks } from '$lib/remote/ops.remote';

	const sinks = listOpsSinks();
	const status = getOpsStatus();
</script>

<PageHeader title="Telemetry" description="granary's traces, logs and metrics, exported to your self-hosted Grafana over OTLP/HTTP.">
	{#snippet actions()}
		{#if isAdmin()}<Button href="/ops/telemetry/new"><PlusIcon /> Add sink</Button>{/if}
	{/snippet}
</PageHeader>

<svelte:boundary>
	{@const s = await status}
	<div class="grid gap-4">
		{#each await sinks as sink (sink.id)}
			<Card.Root data-testid="ops-sink">
				<Card.Header>
					<Card.Title class="flex flex-wrap items-center gap-2">
						<a class="hover:underline" href="/ops/telemetry/{sink.id}">{sink.name}</a>
						<StateBadge state={sink.enabled ? 'enabled' : 'disabled'} tone={sink.enabled ? 'success' : 'muted'} />
					</Card.Title>
					<Card.Description>
						<code>{sink.endpoint}</code> · {AUTH_LABEL[sink.auth.mode]} · {sink.signals.join(', ')}
						{#if sink.grafanaUrl}· <a class="inline-flex items-center gap-0.5 underline" href={sink.grafanaUrl} target="_blank" rel="noreferrer">Open Grafana <ExternalLinkIcon class="size-3" /></a>{/if}
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<svelte:boundary>
						<SinkStats stats={await getOpsSinkStats({ id: sink.id })} state={s.telemetry.find((t) => t.sinkId === sink.id)} />
						{#snippet pending()}<Skeleton class="h-28 w-full" />{/snippet}
						{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
					</svelte:boundary>
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="text-muted-foreground text-sm">No sink yet. Telemetry stays in granary until you add one.</p>
		{/each}
	</div>
	{#snippet failed(error, reset)}<ErrorAlert {error} retry={() => { void sinks.refresh(); reset(); }} />{/snippet}
</svelte:boundary>
