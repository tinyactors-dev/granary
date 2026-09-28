<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SendIcon from '@lucide/svelte/icons/send';
	import GavelIcon from '@lucide/svelte/icons/gavel';
	import UserCheckIcon from '@lucide/svelte/icons/user-check';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import { getOverview, listDeliveries, listVerdicts } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import IssueRef from '$lib/components/app/IssueRef.svelte';
	import TableSkeleton from '$lib/components/app/TableSkeleton.svelte';
	import { INBOX_STATES, OUTBOX_STATES, VERDICT_VALUES, formatBytes } from '$lib/components/app/format';

	const overview = getOverview();
	const recentDeliveries = listDeliveries({ limit: 6 });
	const recentClosures = listVerdicts({ verdict: 'closed', limit: 6 });

	function refreshAll() {
		void overview.refresh();
		void recentDeliveries.refresh();
		void recentClosures.refresh();
	}
	const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
</script>

<PageHeader title="Overview" description="What granary has received, decided and done.">
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refreshAll} disabled={overview.loading}>
			<RefreshCwIcon class={overview.loading ? 'animate-spin' : ''} /> Refresh
		</Button>
	{/snippet}
</PageHeader>

<svelte:boundary>
	{@const o = await overview}
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
		{@render countsCard('Inbox', 'Webhook deliveries by state', '/deliveries', InboxIcon, o.inbox, INBOX_STATES)}
		{@render countsCard('Outbox', 'GitHub effects by state', '/effects', SendIcon, o.outbox, OUTBOX_STATES)}
		{@render countsCard('Verdicts', 'Decisions per issue', '/verdicts', GavelIcon, o.verdicts, VERDICT_VALUES)}

		<Card.Root data-testid="stat-allowlist">
			<Card.Header>
				<Card.Description class="flex items-center gap-2"><UserCheckIcon class="size-4" /> Allowlist</Card.Description>
				<Card.Title class="text-3xl tabular-nums">{o.allowlistSize}</Card.Title>
			</Card.Header>
			<Card.Content class="text-muted-foreground text-sm">
				logins may open issues (plus every OWNER, MEMBER and COLLABORATOR).
				<a href="/allowlist" class="text-foreground underline-offset-4 hover:underline">Manage →</a>
			</Card.Content>
		</Card.Root>

		<Card.Root data-testid="stat-actors">
			<Card.Header>
				<Card.Description class="flex items-center gap-2"><CpuIcon class="size-4" /> Resident actors</Card.Description>
				<Card.Title class="text-3xl tabular-nums">{o.system.residentActors}</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-wrap gap-1.5 text-sm">
				{#each Object.entries(o.system.actorsByFamily) as [family, n] (family)}
					<span class="bg-muted rounded-md px-2 py-0.5 font-mono text-xs">{family} × {n}</span>
				{:else}
					<span class="text-muted-foreground">No resident actors.</span>
				{/each}
			</Card.Content>
		</Card.Root>

		<Card.Root data-testid="stat-messages">
			<Card.Header>
				<Card.Description class="flex items-center gap-2"><ActivityIcon class="size-4" /> Queued messages</Card.Description>
				<Card.Title class="text-3xl tabular-nums">{o.system.queuedMessages}</Card.Title>
			</Card.Header>
			<Card.Content>
				<dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
					<dt class="text-muted-foreground">Delivered</dt>
					<dd class="text-right tabular-nums">{o.system.deliveredMessages}</dd>
					<dt class="text-muted-foreground">Dead letters</dt>
					<dd class="text-right tabular-nums">{o.system.deadLetters}</dd>
					<dt class="text-muted-foreground">Memory</dt>
					<dd class="text-right tabular-nums">{formatBytes(o.system.memoryBytes)}</dd>
					<dt class="text-muted-foreground">Up since</dt>
					<dd class="text-right"><RelativeTime ms={o.system.startedAt} /></dd>
					<dt class="text-muted-foreground">Next relay try</dt>
					<dd class="text-right"><RelativeTime ms={o.nextRelayAttemptAt} /></dd>
				</dl>
			</Card.Content>
		</Card.Root>
	</div>

	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void overview.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>

<div class="grid gap-4 xl:grid-cols-2">
	<Card.Root>
		<Card.Header>
			<Card.Title>Recent deliveries</Card.Title>
			<Card.Description>Newest webhook deliveries in the inbox.</Card.Description>
			<Card.Action><Button href="/deliveries" variant="ghost" size="sm">View all</Button></Card.Action>
		</Card.Header>
		<Card.Content class="px-0">
			<svelte:boundary>
				{@const deliveries = await recentDeliveries}
				<Table.Root>
					<Table.Body>
						{#each deliveries.items as d (d.deliveryId)}
							<Table.Row>
								<Table.Cell class="pl-6"><IssueRef issueKey={d.issueKey} issue={d.issue} /></Table.Cell>
								<Table.Cell class="text-muted-foreground font-mono text-xs">{d.event}{d.action ? `.${d.action}` : ''}</Table.Cell>
								<Table.Cell><StateBadge state={d.state} /></Table.Cell>
								<Table.Cell class="text-muted-foreground pr-6 text-right text-sm"><RelativeTime ms={d.receivedAt} /></Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row><Table.Cell class="text-muted-foreground py-8 text-center">No deliveries yet.</Table.Cell></Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#snippet failed(error, reset)}
					<div class="px-6"><ErrorAlert {error} retry={() => { void recentDeliveries.refresh(); reset(); }} /></div>
				{/snippet}
			</svelte:boundary>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Recent closures</Card.Title>
			<Card.Description>Issues granary closed because the author is not allowed.</Card.Description>
			<Card.Action><Button href="/verdicts?verdict=closed" variant="ghost" size="sm">View all</Button></Card.Action>
		</Card.Header>
		<Card.Content class="px-0">
			<svelte:boundary>
				{@const closures = await recentClosures}
				<Table.Root>
					<Table.Body>
						{#each closures.items as v (v.issueKey)}
							<Table.Row>
								<Table.Cell class="pl-6"><IssueRef issueKey={v.issueKey} issue={v.issue} /></Table.Cell>
								<Table.Cell class="text-sm">{v.issue?.author ?? '—'}</Table.Cell>
								<Table.Cell class="text-muted-foreground pr-6 text-right text-sm"><RelativeTime ms={v.decidedAt} /></Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row><Table.Cell class="text-muted-foreground py-8 text-center">Nothing closed yet.</Table.Cell></Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#snippet failed(error, reset)}
					<div class="px-6"><ErrorAlert {error} retry={() => { void recentClosures.refresh(); reset(); }} /></div>
				{/snippet}
			</svelte:boundary>
		</Card.Content>
	</Card.Root>
</div>

{#snippet countsCard(
	title: string,
	description: string,
	href: string,
	Icon: typeof InboxIcon,
	counts: Record<string, number>,
	order: readonly string[]
)}
	<Card.Root data-testid="stat-{title.toLowerCase()}">
		<Card.Header>
			<Card.Description class="flex items-center gap-2"><Icon class="size-4" /> {title}</Card.Description>
			<Card.Title class="text-3xl tabular-nums">{sum(counts)}</Card.Title>
			<Card.Action><Button {href} variant="ghost" size="xs">View</Button></Card.Action>
		</Card.Header>
		<Card.Content>
			<p class="text-muted-foreground mb-2 text-xs">{description}</p>
			<div class="flex flex-wrap gap-x-3 gap-y-1.5">
				{#each order as state (state)}
					<a href="{href}?{href === '/verdicts' ? 'verdict' : 'state'}={state}" class="flex items-center gap-1.5 text-sm">
						<StateBadge {state} /><span class="tabular-nums font-medium">{counts[state] ?? 0}</span>
					</a>
				{/each}
			</div>
		</Card.Content>
	</Card.Root>
{/snippet}
