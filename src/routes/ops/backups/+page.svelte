<script lang="ts">
	import type { BackupRunSummary, RunState } from '$lib/ops/contract';
	import { page } from '$app/state';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import PagedTable from '$lib/components/app/PagedTable.svelte';
	import FilterTabs from '$lib/components/app/FilterTabs.svelte';
	import { runTriggerLabel } from '$lib/components/app/glossary';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import RunNowButton from '$lib/components/ops/RunNowButton.svelte';
	import { RUN_STATES, bytes, duration, runTone, uploadTone } from '$lib/components/ops/format';
	import { listOpsDestinations, listOpsPlans, listOpsRuns } from '$lib/remote/ops.remote';

	const plans = listOpsPlans();
	const destinations = listOpsDestinations();
	const state = $derived((RUN_STATES as string[]).includes(page.url.searchParams.get('state') ?? '') ? (page.url.searchParams.get('state') as RunState) : null);
</script>

<PageHeader title="Backups" description="Each run copies a database, compresses and encrypts it, uploads it to every destination and checks the upload." />

<svelte:boundary>
	{@const planList = await plans}
	{@const dests = await destinations}
	{@const destName = (id: string) => dests.find((d) => d.id === id)?.name ?? id}
	<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
		{#each planList as p (p.id)}
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>{p.name}</Card.Title>
					<Card.Description>
						{p.databases.join(' + ')} → {p.destinationIds.map(destName).join(', ')}
					</Card.Description>
				</Card.Header>
				<Card.Content class="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm">
					<span>
						every {duration(p.effectiveIntervalMs)}
						{#if p.effectiveIntervalMs !== p.intervalMs}<span class="text-foreground">(stretched from {duration(p.intervalMs)} to fit the egress budget)</span>{/if}
						{#if !p.enabled}· <span class="text-foreground">paused</span>{/if}
					</span>
					<RunNowButton planId={p.id} />
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="text-muted-foreground text-sm">No backup plan yet. <a class="underline" href="/ops/plans">Create one</a>.</p>
		{/each}
	</div>

	<FilterTabs values={RUN_STATES} current={state} />
	{#key state}
		<PagedTable load={(before) => listOpsRuns({ ...(state ? { state } : {}), ...(before ? { before } : {}), limit: 50 })} columns={6} empty="No runs match.">
			{#snippet header()}
				<Table.Head>Run</Table.Head>
				<Table.Head>Database</Table.Head>
				<Table.Head>State</Table.Head>
				<Table.Head>Destinations</Table.Head>
				<Table.Head class="text-right">Sealed size</Table.Head>
				<Table.Head>Started</Table.Head>
			{/snippet}
			{#snippet row(r: BackupRunSummary)}
				<Table.Row data-testid="ops-run-row">
					<Table.Cell><a class="font-medium hover:underline" href="/ops/backups/{r.id}" title={r.id}>{runTriggerLabel(r.trigger)}</a></Table.Cell>
					<Table.Cell>{r.database}</Table.Cell>
					<Table.Cell><StateBadge state={r.state} tone={runTone(r.state)} /></Table.Cell>
					<Table.Cell>
						<div class="flex flex-wrap gap-1">
							{#each r.destinations as d (d.destinationId)}
								<span class="text-muted-foreground inline-flex items-center gap-1 text-xs">{destName(d.destinationId)} <StateBadge state={d.state} tone={uploadTone(d.state)} /></span>
							{/each}
						</div>
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{bytes(r.sealedBytes)}</Table.Cell>
					<Table.Cell><RelativeTime ms={r.startedAt} /></Table.Cell>
				</Table.Row>
			{/snippet}
		</PagedTable>
	{/key}
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void plans.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
