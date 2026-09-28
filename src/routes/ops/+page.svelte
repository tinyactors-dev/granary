<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import SleepHero from '$lib/components/ops/SleepHero.svelte';
	import ConditionCard from '$lib/components/ops/ConditionCard.svelte';
	import EventTimeline from '$lib/components/ops/EventTimeline.svelte';
	import ProjectionMeters from '$lib/components/ops/ProjectionMeters.svelte';
	import { DAY, bytes, drillTone, KIND_LABEL } from '$lib/components/ops/format';
	import {
		getOpsProjections,
		getOpsStatus,
		listOpsConditions,
		listOpsDestinations,
		listOpsEvents,
		listOpsSinks
	} from '$lib/remote/ops.remote';

	const status = getOpsStatus();
	const conditions = listOpsConditions();
	const destinations = listOpsDestinations();
	const sinks = listOpsSinks();
	const handled = listOpsEvents({ kind: 'handled', limit: 50 });
</script>

<PageHeader title="Ops" description="Backups, telemetry and self-healing. Nothing here wakes anyone up — it waits for your next visit." />

<svelte:boundary>
	{@const s = await status}
	{@const dests = await destinations}
	{@const sinkList = await sinks}
	{@const nameOf = (id: string) => dests.find((d) => d.id === id)?.name ?? id}
	<SleepHero status={s} />

	<div class="grid gap-4 lg:grid-cols-3">
		<Card.Root class="lg:col-span-2">
			<Card.Header>
				<Card.Title>Last verified backup</Card.Title>
				<Card.Description>Per database and destination. Off-site copies are what let you sleep.</Card.Description>
			</Card.Header>
			<Card.Content class="px-0">
				<Table.Root>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head class="pl-6">Database</Table.Head>
							<Table.Head>Destination</Table.Head>
							<Table.Head>Verified</Table.Head>
							<Table.Head class="text-right">Size</Table.Head>
							<Table.Head class="pr-6">Window</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each s.backups as b (b.database + b.destinationId)}
							<Table.Row data-testid="ops-backup-row">
								<Table.Cell class="pl-6 font-medium">{b.database}</Table.Cell>
								<Table.Cell>
									<a class="hover:underline" href="/ops/destinations/{b.destinationId}">{nameOf(b.destinationId)}</a>
									<div class="text-muted-foreground text-xs">{KIND_LABEL[b.destinationKind]}{b.offsite ? ', off-site' : ', same disk'}</div>
								</Table.Cell>
								<Table.Cell><RelativeTime ms={b.lastVerifiedAt} /></Table.Cell>
								<Table.Cell class="text-right tabular-nums">{bytes(b.lastVerifiedBytes)}</Table.Cell>
								<Table.Cell class="pr-6">
									<StateBadge state={b.withinWindow ? 'current' : 'stale'} tone={b.withinWindow ? 'success' : 'warning'} />
								</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row class="hover:bg-transparent">
								<Table.Cell colspan={5} class="text-muted-foreground py-8 text-center">
									No backups yet. <a class="underline" href="/ops/destinations/new">Add a destination</a> and a <a class="underline" href="/ops/plans">plan</a>.
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>

		<div class="grid content-start gap-4">
			<Card.Root>
				<Card.Header>
					<Card.Title>Last restore drill</Card.Title>
					<Card.Description>Proves the backups can actually be restored.</Card.Description>
				</Card.Header>
				<Card.Content class="text-sm">
					{#if s.lastDrill}
						<div class="flex items-center gap-2">
							<StateBadge state={!s.lastDrill.result ? 'running' : s.lastDrill.result === 'ok' ? 'passed' : s.lastDrill.result} tone={drillTone(s.lastDrill.result ?? null)} />
							{#if s.lastDrill.at}<RelativeTime ms={s.lastDrill.at} />{/if}
						</div>
						<p class="text-muted-foreground mt-1">from {nameOf(s.lastDrill.destinationId)} · <a class="underline" href="/ops/drills">history</a></p>
					{:else}
						<p class="text-muted-foreground">No drill has run yet.</p>
					{/if}
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Title>Telemetry</Card.Title>
					<Card.Description>Traces, logs and metrics to Grafana.</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-2 text-sm">
					{#each s.telemetry as t (t.sinkId)}
						<div class="flex flex-wrap items-center gap-2" data-testid="ops-telemetry-row">
							<a class="font-medium hover:underline" href="/ops/telemetry/{t.sinkId}">{sinkList.find((x) => x.id === t.sinkId)?.name ?? t.sinkId}</a>
							<StateBadge state={t.state} tone={t.state === 'open' ? 'warning' : t.state === 'disabled' ? 'muted' : 'success'} />
							<span class="text-muted-foreground text-xs">last export <RelativeTime ms={t.lastSuccessAt} />{t.droppedLast24h ? ` · ${t.droppedLast24h} dropped in 24 h` : ''}</span>
						</div>
					{:else}
						<p class="text-muted-foreground">No telemetry sink. <a class="underline" href="/ops/telemetry/new">Add one</a>.</p>
					{/each}
				</Card.Content>
			</Card.Root>
		</div>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<Card.Root>
			<Card.Header>
				<Card.Title>Waiting for you</Card.Title>
				<Card.Description>Things self-healing couldn't fix. None of them is urgent.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-3">
				{@const open = (await conditions).filter((c) => c.state === 'attention')}
				{#each open as c (c.id)}
					<ConditionCard condition={c} compact />
				{:else}
					<p class="text-muted-foreground text-sm">Nothing. Everything else is <a class="underline" href="/ops/conditions">ok or fixing itself</a>.</p>
				{/each}
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title>Handled automatically</Card.Title>
				<Card.Description>The last 7 days.</Card.Description>
			</Card.Header>
			<Card.Content>
				{@const recent = (await handled).items.filter((e) => e.at > s.at - 7 * DAY)}
				<EventTimeline events={recent} empty="Nothing needed fixing this week." />
			</Card.Content>
		</Card.Root>
	</div>

	{@const offsite = dests.filter((d) => d.settings.kind !== 'local-dir')}
	{#if offsite.length}
		<div class="grid gap-4 lg:grid-cols-2">
			{#each offsite as d (d.id)}
				<Card.Root>
					<Card.Header>
						<Card.Title>{d.name}</Card.Title>
						<Card.Description>Projected storage and egress — bounded, not an archive.</Card.Description>
					</Card.Header>
					<Card.Content>
						<svelte:boundary>
							<ProjectionMeters projections={await getOpsProjections({ id: d.id })} />
							{#snippet pending()}<Skeleton class="h-24 w-full" />{/snippet}
							{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
						</svelte:boundary>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}

	{#snippet failed(error, reset)}
		<ErrorAlert {error} title="Ops is unavailable" retry={() => { void status.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
