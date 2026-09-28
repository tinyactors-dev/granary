<!--
	/admin/deliveries: every webhook delivery, newest first. By default only the
	ones that are not about an issue or pull request (installation events,
	pings, ignored events), which Activity does not show (ADR 0291).
-->
<script lang="ts">
	import { page } from '$app/state';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { DeliverySummary } from '$lib/schemas/api';
	import { INBOX_STATES, type InboxState } from '$lib/schemas/wal';
	import { listDeliveries } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import FilterTabs from '$lib/components/app/FilterTabs.svelte';
	import PagedTable from '$lib/components/app/PagedTable.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import IssueRef from '$lib/components/app/IssueRef.svelte';
	import { DELIVERY_LABELS } from '$lib/components/app/glossary';

	const showAll = $derived(page.url.searchParams.get('show') === 'all');
	const outcomeFilter = $derived.by((): InboxState | undefined => {
		const s = page.url.searchParams.get('state');
		return (INBOX_STATES as readonly string[]).includes(s ?? '') ? (s as InboxState) : undefined;
	});
	let generation = $state(0);
	const load = (before: string | undefined) =>
		listDeliveries({ ...(showAll ? {} : { about: 'other' as const }), ...(outcomeFilter ? { state: outcomeFilter } : {}), ...(before ? { before } : {}) });

	function refresh() {
		void load(undefined).refresh();
		generation++;
	}
	const eventName = (d: DeliverySummary) => (d.action ? `${d.event}.${d.action}` : d.event);
</script>

<PageHeader
	title="Deliveries"
	description="Every webhook GitHub sent, newest first. Activity lists issues and pull requests; this also shows installation events, pings and deliveries granary ignored."
>
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refresh}><RefreshCwIcon /> Refresh</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap gap-2">
	<FilterTabs param="show" values={['all']} current={showAll ? 'all' : null} labels={{ all: 'All deliveries' }} allLabel="Not about an item" />
	<FilterTabs param="state" values={INBOX_STATES} current={outcomeFilter ?? null} labels={DELIVERY_LABELS} allLabel="Any outcome" />
</div>

{#key `${showAll}:${outcomeFilter}:${generation}`}
	<PagedTable {load} columns={4} empty={showAll ? 'No deliveries yet.' : 'No deliveries outside issues and pull requests yet.'}>
		{#snippet header()}
			<Table.Head>Event</Table.Head>
			<Table.Head>Delivery</Table.Head>
			<Table.Head>Outcome</Table.Head>
			<Table.Head class="text-right">Received</Table.Head>
		{/snippet}
		{#snippet row(d: DeliverySummary)}
			<Table.Row data-testid="delivery-row" data-event={d.event}>
				<Table.Cell class="max-w-[24rem]">
					<span class="font-mono text-sm">{eventName(d)}</span>
					{#if d.issueKey}<div class="min-w-0 text-xs"><IssueRef issueKey={d.issueKey} issue={d.issue} /></div>{/if}
				</Table.Cell>
				<Table.Cell>
					<span class="inline-flex items-center gap-1 font-mono text-xs" title={d.deliveryId}>{d.deliveryId.slice(0, 8)}…<CopyButton text={d.deliveryId} /></span>
				</Table.Cell>
				<Table.Cell>
					<StateBadge state={d.state} label={DELIVERY_LABELS[d.state] ?? d.state} />
					{#if d.ignoreReason}<span class="text-muted-foreground mt-0.5 block max-w-72 truncate text-xs" title={d.ignoreReason}>{d.ignoreReason}</span>{/if}
				</Table.Cell>
				<Table.Cell class="text-muted-foreground text-right text-sm"><RelativeTime ms={d.receivedAt} /></Table.Cell>
			</Table.Row>
		{/snippet}
	</PagedTable>
{/key}
