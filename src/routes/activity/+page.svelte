<!--
	Activity (ADR 0291): one row per issue or pull request — who opened it,
	what granary decided and whether the GitHub action finished. Replaces the
	separate Deliveries, Effects and Verdicts tables; the item page has the
	full timeline.
-->
<script lang="ts">
	import { page } from '$app/state';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { ACTIVITY_OUTCOMES, type ActivityItem, type ActivityOutcome, type ItemKind } from '$lib/schemas/api';
	import { listActivity } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import FilterTabs from '$lib/components/app/FilterTabs.svelte';
	import PagedTable from '$lib/components/app/PagedTable.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import IssueRef from '$lib/components/app/IssueRef.svelte';
	import { ACTION_LABELS, KIND_LABELS, OUTCOME_LABELS, reasonLabel } from '$lib/components/app/glossary';

	const KINDS: readonly ItemKind[] = ['issue', 'pull_request'];
	const outcome = $derived.by((): ActivityOutcome | undefined => {
		const s = page.url.searchParams.get('outcome');
		return (ACTIVITY_OUTCOMES as readonly string[]).includes(s ?? '') ? (s as ActivityOutcome) : undefined;
	});
	const kind = $derived.by((): ItemKind | undefined => {
		const s = page.url.searchParams.get('kind');
		return KINDS.includes(s as ItemKind) ? (s as ItemKind) : undefined;
	});
	let generation = $state(0);
	const load = (before: string | undefined) =>
		listActivity({ ...(outcome ? { outcome } : {}), ...(kind ? { kind } : {}), ...(before ? { before } : {}) });

	function refresh() {
		void load(undefined).refresh();
		generation++;
	}

	/** One line under the outcome: why, or what is still happening. */
	function detail(a: ActivityItem): string {
		if (a.decision) return reasonLabel(a.decision.reason);
		if (a.action) return `GitHub action: ${ACTION_LABELS[a.action.state] ?? a.action.state}${a.action.attempts > 1 ? ` (attempt ${a.action.attempts})` : ''}`;
		if (a.latestDelivery?.ignoreReason) return a.latestDelivery.ignoreReason;
		return '';
	}
</script>

<PageHeader title="Activity" description="Every issue and pull request granary has seen, what it decided and whether GitHub has been updated. Newest first.">
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refresh}><RefreshCwIcon /> Refresh</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap gap-2">
	<FilterTabs param="outcome" values={ACTIVITY_OUTCOMES} current={outcome ?? null} labels={OUTCOME_LABELS} allLabel="All outcomes" />
	<FilterTabs param="kind" values={KINDS} current={kind ?? null} labels={KIND_LABELS} allLabel="Issues & PRs" />
</div>

{#key `${outcome}:${kind}:${generation}`}
	<PagedTable {load} columns={4} empty="Nothing matches these filters.">
		{#snippet header()}
			<Table.Head>Item</Table.Head>
			<Table.Head>Author</Table.Head>
			<Table.Head>Outcome</Table.Head>
			<Table.Head class="text-right">Updated</Table.Head>
		{/snippet}
		{#snippet row(a: ActivityItem)}
			<Table.Row data-testid="activity-row">
				<Table.Cell class="max-w-[28rem]">
					<div class="flex items-start gap-2">
						<span class="text-muted-foreground bg-muted mt-0.5 shrink-0 rounded px-1.5 text-[11px] font-medium" data-testid="item-kind">{a.kind === 'pull_request' ? 'PR' : 'Issue'}</span>
						<div class="min-w-0"><IssueRef issueKey={a.issueKey} issue={a.issue} /></div>
					</div>
				</Table.Cell>
				<Table.Cell class="text-sm">{a.issue?.author ?? '—'}</Table.Cell>
				<Table.Cell>
					<StateBadge state={a.outcome} label={OUTCOME_LABELS[a.outcome]} />
					{#if detail(a)}<span class="text-muted-foreground mt-0.5 block max-w-72 truncate text-xs" title={detail(a)}>{detail(a)}</span>{/if}
				</Table.Cell>
				<Table.Cell class="text-muted-foreground text-right text-sm"><RelativeTime ms={a.updatedAt} /></Table.Cell>
			</Table.Row>
		{/snippet}
	</PagedTable>
{/key}
