<script lang="ts">
	import { page } from '$app/state';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { InboxState } from '$lib/schemas/wal';
	import type { DeliverySummary } from '$lib/schemas/api';
	import { listDeliveries } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import FilterTabs from '$lib/components/app/FilterTabs.svelte';
	import PagedTable from '$lib/components/app/PagedTable.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import IssueRef from '$lib/components/app/IssueRef.svelte';
	import { INBOX_STATES } from '$lib/components/app/format';

	const filter = $derived.by((): InboxState | undefined => {
		const s = page.url.searchParams.get('state');
		return INBOX_STATES.includes(s as InboxState) ? (s as InboxState) : undefined;
	});
	let generation = $state(0);
	const load = (before: string | undefined) => listDeliveries({ ...(filter ? { state: filter } : {}), ...(before ? { before } : {}) });

	function refresh() {
		// Remount the table: drops loaded pages and refetches page one.
		void load(undefined).refresh();
		generation++;
	}
</script>

<PageHeader title="Deliveries" description="Every webhook delivery granary stored in its inbox, newest first.">
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refresh}><RefreshCwIcon /> Refresh</Button>
	{/snippet}
</PageHeader>

<FilterTabs values={INBOX_STATES} current={filter ?? null} />

{#key `${filter}:${generation}`}
	<PagedTable {load} columns={5} empty="No deliveries match this filter.">
		{#snippet header()}
			<Table.Head>Issue</Table.Head>
			<Table.Head>Event</Table.Head>
			<Table.Head>State</Table.Head>
			<Table.Head>Delivery id</Table.Head>
			<Table.Head class="text-right">Received</Table.Head>
		{/snippet}
		{#snippet row(d: DeliverySummary)}
			<Table.Row>
				<Table.Cell><IssueRef issueKey={d.issueKey} issue={d.issue} /></Table.Cell>
				<Table.Cell class="font-mono text-xs">{d.event}{d.action ? `.${d.action}` : ''}</Table.Cell>
				<Table.Cell><StateBadge state={d.state} /></Table.Cell>
				<Table.Cell class="text-muted-foreground max-w-48 truncate font-mono text-xs" title={d.deliveryId}>{d.deliveryId}</Table.Cell>
				<Table.Cell class="text-muted-foreground text-right text-sm"><RelativeTime ms={d.receivedAt} /></Table.Cell>
			</Table.Row>
		{/snippet}
	</PagedTable>
{/key}
