<script lang="ts">
	import { page } from '$app/state';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { OutboxState } from '$lib/schemas/wal';
	import type { EffectSummary } from '$lib/schemas/api';
	import { listEffects } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import FilterTabs from '$lib/components/app/FilterTabs.svelte';
	import PagedTable from '$lib/components/app/PagedTable.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import IssueRef from '$lib/components/app/IssueRef.svelte';
	import RetryEffectButton from '$lib/components/app/RetryEffectButton.svelte';
	import { OUTBOX_STATES } from '$lib/components/app/format';

	const filter = $derived.by((): OutboxState | undefined => {
		const s = page.url.searchParams.get('state');
		return OUTBOX_STATES.includes(s as OutboxState) ? (s as OutboxState) : undefined;
	});
	let generation = $state(0);
	/** Cursors of the pages currently shown, so a retry can refresh exactly those queries. */
	const loaded = $derived.by(() => {
		void filter;
		void generation;
		return new Set<string | undefined>();
	});
	const load = (before: string | undefined) => {
		loaded.add(before);
		return listEffects({ ...(filter ? { state: filter } : {}), ...(before ? { before } : {}) });
	};
	const visibleQueries = () => [...loaded].map((before) => load(before));

	function refresh() {
		void load(undefined).refresh();
		generation++;
	}
</script>

<PageHeader title="Effects" description="GitHub side effects in the outbox (close + comment), newest first.">
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refresh}><RefreshCwIcon /> Refresh</Button>
	{/snippet}
</PageHeader>

<FilterTabs values={OUTBOX_STATES} current={filter ?? null} />

{#key `${filter}:${generation}`}
	<PagedTable {load} columns={6} empty="No effects match this filter.">
		{#snippet header()}
			<Table.Head>Issue</Table.Head>
			<Table.Head>State</Table.Head>
			<Table.Head class="text-right">Attempts</Table.Head>
			<Table.Head>Last error / next attempt</Table.Head>
			<Table.Head class="text-right">Updated</Table.Head>
			<Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
		{/snippet}
		{#snippet row(e: EffectSummary)}
			<Table.Row>
				<Table.Cell>
					<IssueRef issueKey={e.issueKey} issue={e.payload} />
					<span class="text-muted-foreground block font-mono text-[11px]">{e.effectKey}</span>
				</Table.Cell>
				<Table.Cell><StateBadge state={e.state} /></Table.Cell>
				<Table.Cell class="text-right tabular-nums">{e.attempts}</Table.Cell>
				<Table.Cell class="max-w-80 text-xs">
					{#if e.lastError}
						<span class="block truncate font-mono text-red-700 dark:text-red-400" title={e.lastError}>{e.lastError}</span>
					{/if}
					{#if e.state === 'pending' && e.nextAttemptAt}
						<span class="text-muted-foreground">next try <RelativeTime ms={e.nextAttemptAt} /></span>
					{:else if e.commentId !== null}
						<span class="text-muted-foreground">comment #{e.commentId}</span>
					{:else if !e.lastError}
						<span class="text-muted-foreground">—</span>
					{/if}
				</Table.Cell>
				<Table.Cell class="text-muted-foreground text-right text-sm"><RelativeTime ms={e.updatedAt} /></Table.Cell>
				<Table.Cell class="text-right">
					{#if e.state === 'dead'}
						<RetryEffectButton effectKey={e.effectKey} updates={visibleQueries} />
					{/if}
				</Table.Cell>
			</Table.Row>
		{/snippet}
	</PagedTable>
{/key}
