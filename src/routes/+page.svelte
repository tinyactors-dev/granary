<!--
	Overview (ADR 0291): what granary decided, whether GitHub is up to date,
	the policy at a glance and the latest activity. Actor-system internals
	(resident actors, queues, memory) live in /admin.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import GavelIcon from '@lucide/svelte/icons/gavel';
	import SendIcon from '@lucide/svelte/icons/send';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { getOverview, listActivity } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import IssueRef from '$lib/components/app/IssueRef.svelte';
	import { VERDICT_VALUES } from '$lib/components/app/format';
	import { OUTCOME_LABELS } from '$lib/components/app/glossary';

	const overview = getOverview();
	const recent = listActivity({ limit: 8 });

	function refreshAll() {
		void overview.refresh();
		void recent.refresh();
	}
	const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
</script>

<PageHeader title="Overview" description="What granary decided, and whether GitHub is up to date.">
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refreshAll} disabled={overview.loading}>
			<RefreshCwIcon class={overview.loading ? 'animate-spin' : ''} /> Refresh
		</Button>
	{/snippet}
</PageHeader>

<svelte:boundary>
	{@const o = await overview}
	{@const waiting = (o.outbox.pending ?? 0) + (o.outbox.inflight ?? 0)}
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
		<Card.Root data-testid="stat-decisions">
			<Card.Header>
				<Card.Description class="flex items-center gap-2"><GavelIcon class="size-4" /> Decisions</Card.Description>
				<Card.Title class="text-3xl tabular-nums">{sum(o.verdicts)}</Card.Title>
				<Card.Action><Button href="/activity" variant="ghost" size="xs">Activity</Button></Card.Action>
			</Card.Header>
			<Card.Content class="flex flex-wrap gap-x-3 gap-y-1.5">
				{#each VERDICT_VALUES as v (v)}
					<a href="/activity?outcome={v}" class="flex items-center gap-1.5 text-sm">
						<StateBadge state={v} label={OUTCOME_LABELS[v]} /><span class="font-medium tabular-nums">{o.verdicts[v] ?? 0}</span>
					</a>
				{/each}
			</Card.Content>
		</Card.Root>

		<Card.Root data-testid="stat-actions">
			<Card.Header>
				<Card.Description class="flex items-center gap-2"><SendIcon class="size-4" /> GitHub actions</Card.Description>
				<Card.Title class="text-3xl tabular-nums">{waiting}</Card.Title>
				<Card.Action><Button href="/activity?outcome=closing" variant="ghost" size="xs">Activity</Button></Card.Action>
			</Card.Header>
			<Card.Content class="text-muted-foreground space-y-1 text-sm">
				<p>{waiting === 0 ? 'Nothing waiting: GitHub is up to date.' : `${waiting} comment-and-close ${waiting === 1 ? 'action is' : 'actions are'} still under way.`}</p>
				{#if (o.outbox.dead ?? 0) > 0}
					<p class="text-red-700 dark:text-red-400"><a href="/activity?outcome=failed" class="underline-offset-4 hover:underline">{o.outbox.dead} gave up after retries</a> — retry them from the item page.</p>
				{/if}
				{#if o.nextRelayAttemptAt}<p>Next retry <RelativeTime ms={o.nextRelayAttemptAt} />.</p>{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root data-testid="stat-allowlist">
			<Card.Header>
				<Card.Description class="flex items-center gap-2"><ShieldCheckIcon class="size-4" /> Policy</Card.Description>
				<Card.Title class="text-3xl tabular-nums">{o.allowlistSize}</Card.Title>
				<Card.Action><Button href="/policy" variant="ghost" size="xs">Policy</Button></Card.Action>
			</Card.Header>
			<Card.Content class="text-muted-foreground text-sm">
				logins on the allowlist. Repository owners, members and collaborators are always allowed unless blocked.
			</Card.Content>
		</Card.Root>
	</div>

	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void overview.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>

<Card.Root>
	<Card.Header>
		<Card.Title>Recent activity</Card.Title>
		<Card.Description>The latest issues and pull requests granary has seen.</Card.Description>
		<Card.Action><Button href="/activity" variant="ghost" size="sm">All activity</Button></Card.Action>
	</Card.Header>
	<Card.Content class="px-0">
		<svelte:boundary>
			{@const page = await recent}
			<div class="overflow-x-auto">
			<Table.Root>
				<Table.Body>
					{#each page.items as a (a.issueKey)}
						<Table.Row>
							<Table.Cell class="max-w-[28rem] pl-6">
								<div class="flex items-start gap-2">
									<span class="text-muted-foreground bg-muted mt-0.5 shrink-0 rounded px-1.5 text-[11px] font-medium">{a.kind === 'pull_request' ? 'PR' : 'Issue'}</span>
									<div class="min-w-0"><IssueRef issueKey={a.issueKey} issue={a.issue} /></div>
								</div>
							</Table.Cell>
							<Table.Cell class="text-sm">{a.issue?.author ?? '—'}</Table.Cell>
							<Table.Cell><StateBadge state={a.outcome} label={OUTCOME_LABELS[a.outcome]} /></Table.Cell>
							<Table.Cell class="text-muted-foreground pr-6 text-right text-sm"><RelativeTime ms={a.updatedAt} /></Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row><Table.Cell class="text-muted-foreground py-8 text-center">Nothing yet. Issues and pull requests appear here as GitHub reports them.</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			</div>
			{#snippet failed(error, reset)}
				<div class="px-6"><ErrorAlert {error} retry={() => { void recent.refresh(); reset(); }} /></div>
			{/snippet}
		</svelte:boundary>
	</Card.Content>
</Card.Root>
