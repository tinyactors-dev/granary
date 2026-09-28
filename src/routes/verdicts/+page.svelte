<script lang="ts">
	import { page } from '$app/state';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { VerdictValue } from '$lib/schemas/wal';
	import type { VerdictSummary } from '$lib/schemas/api';
	import { listVerdicts } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import FilterTabs from '$lib/components/app/FilterTabs.svelte';
	import PagedTable from '$lib/components/app/PagedTable.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import IssueRef from '$lib/components/app/IssueRef.svelte';
	import { VERDICT_VALUES } from '$lib/components/app/format';

	const verdict = $derived.by((): VerdictValue | undefined => {
		const s = page.url.searchParams.get('verdict');
		return VERDICT_VALUES.includes(s as VerdictValue) ? (s as VerdictValue) : undefined;
	});
	let generation = $state(0);
	const load = (before: string | undefined) =>
		listVerdicts({ ...(verdict ? { verdict } : {}), ...(before ? { before } : {}) });

	function refresh() {
		void load(undefined).refresh();
		generation++;
	}
</script>

<PageHeader title="Verdicts" description="What granary decided for each issue, newest first.">
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refresh}><RefreshCwIcon /> Refresh</Button>
	{/snippet}
</PageHeader>

<FilterTabs param="verdict" values={VERDICT_VALUES} current={verdict ?? null} />

{#key `${verdict}:${generation}`}
	<PagedTable {load} columns={5} empty="No verdicts match this filter.">
		{#snippet header()}
			<Table.Head>Issue</Table.Head>
			<Table.Head>Author</Table.Head>
			<Table.Head>Verdict</Table.Head>
			<Table.Head>Reason</Table.Head>
			<Table.Head class="text-right">Decided</Table.Head>
		{/snippet}
		{#snippet row(v: VerdictSummary)}
			<Table.Row>
				<Table.Cell><IssueRef issueKey={v.issueKey} issue={v.issue} /></Table.Cell>
				<Table.Cell class="text-sm">
					{#if v.issue}
						{v.issue.author}
						<span class="text-muted-foreground block font-mono text-[11px]">{v.issue.association}</span>
					{:else}—{/if}
				</Table.Cell>
				<Table.Cell><StateBadge state={v.verdict} /></Table.Cell>
				<Table.Cell class="max-w-72 truncate font-mono text-xs" title={v.reason}>{v.reason}</Table.Cell>
				<Table.Cell class="text-muted-foreground text-right text-sm"><RelativeTime ms={v.decidedAt} /></Table.Cell>
			</Table.Row>
		{/snippet}
	</PagedTable>
{/key}
