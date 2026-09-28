<script lang="ts">
	import type { RestoreDrillSummary } from '$lib/ops/contract';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import { toast } from 'svelte-sonner';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import PagedTable from '$lib/components/app/PagedTable.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { drillTone, duration } from '$lib/components/ops/format';
	import { listOpsDestinations, listOpsDrills, runOpsDrillNow } from '$lib/remote/ops.remote';

	const destinations = listOpsDestinations();
	let busy = $state<string | null>(null);

	async function drill(id: string, name: string) {
		busy = id;
		try {
			await runOpsDrillNow({ id }).updates(listOpsDrills({ limit: 50 }));
			toast.success(`Restore drill started for ${name}`, { description: 'Download → decrypt → checksum → integrity_check → row counts.' });
		} catch (e) {
			toast.error('Could not start the drill', { description: describeError(e).message });
		} finally {
			busy = null;
		}
	}
</script>

<PageHeader title="Restore drills" description="Regularly proves a backup can be downloaded, decrypted and opened — so the day you need it isn't the first time." />

<svelte:boundary>
	{@const dests = await destinations}
	<div class="flex flex-wrap gap-2">
		{#each dests.filter((d) => d.enabled) as d (d.id)}
			<AdminOnly reason="Only admins can start drills">
				{#snippet children({ disabled })}
					<Button variant="outline" size="sm" disabled={disabled || busy === d.id} onclick={() => drill(d.id, d.name)}><FlaskConicalIcon /> Drill {d.name} now</Button>
				{/snippet}
			</AdminOnly>
		{/each}
	</div>
		<PagedTable load={(before) => listOpsDrills({ ...(before ? { before } : {}), limit: 50 })} columns={6} empty="No drills yet.">
			{#snippet header()}
				<Table.Head>Started</Table.Head>
				<Table.Head>Destination</Table.Head>
				<Table.Head>Database</Table.Head>
				<Table.Head>Result</Table.Head>
				<Table.Head>Backup age (RPO)</Table.Head>
				<Table.Head>Restore time (RTO)</Table.Head>
			{/snippet}
			{#snippet row(d: RestoreDrillSummary)}
				<Table.Row data-testid="ops-drill">
					<Table.Cell><RelativeTime ms={d.startedAt} /></Table.Cell>
					<Table.Cell>{dests.find((x) => x.id === d.destinationId)?.name ?? d.destinationId}</Table.Cell>
					<Table.Cell>{d.database}</Table.Cell>
					<Table.Cell>
						<StateBadge state={d.result === null ? 'running' : d.result === 'ok' ? 'passed' : d.result} tone={drillTone(d.result)} />
						{#if d.detail}<span class="text-muted-foreground block text-xs">{d.detail}</span>{/if}
					</Table.Cell>
					<Table.Cell>{duration(d.rpoMs)}</Table.Cell>
					<Table.Cell>{duration(d.rtoMs)}</Table.Cell>
				</Table.Row>
			{/snippet}
		</PagedTable>
	{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
</svelte:boundary>
