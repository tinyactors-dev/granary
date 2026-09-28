<script lang="ts">
	import { page } from '$app/state';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { getIssue } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import JsonView from '$lib/components/app/JsonView.svelte';
	import RetryEffectButton from '$lib/components/app/RetryEffectButton.svelte';
	import ActorPanel from '$lib/components/app/ActorPanel.svelte';
	import { ISSUE_KEY_RE, issueLabel } from '$lib/components/app/format';

	const key = $derived(page.params.key ?? '');
	const valid = $derived(ISSUE_KEY_RE.test(key));
	const issue = $derived(valid ? getIssue({ issueKey: key }) : null);
</script>

{#if !issue}
	<PageHeader title="Issue {key}" />
	<Alert.Root variant="destructive">
		<CircleAlertIcon />
		<Alert.Title>Not an issue key</Alert.Title>
		<Alert.Description>Issue keys look like <code>&lt;repository id&gt;-&lt;issue number&gt;</code>, e.g. <code>700001-3</code>.</Alert.Description>
	</Alert.Root>
{:else}
	<svelte:boundary>
		{@const d = await issue}
		{#if !d}
			<PageHeader title="Issue {key}" />
			<Alert.Root>
				<CircleAlertIcon />
				<Alert.Title>Unknown issue</Alert.Title>
				<Alert.Description>granary has no deliveries, effects, verdict or resident actor for <code>{key}</code>.</Alert.Description>
			</Alert.Root>
		{:else}
			<PageHeader
				title={d.issue ? issueLabel(d.issue) : `Issue ${d.issueKey}`}
				description={d.issue?.title ?? `repository ${d.repoId}, issue #${d.number}`}
			>
				{#snippet actions()}
					{#if d.issue}
						<Button href={d.issue.htmlUrl} target="_blank" rel="noreferrer" variant="ghost" size="sm">
							<ExternalLinkIcon /> On GitHub
						</Button>
					{/if}
					<Button variant="outline" size="sm" onclick={() => issue.refresh()} disabled={issue.loading}>
						<RefreshCwIcon class={issue.loading ? 'animate-spin' : ''} /> Refresh
					</Button>
				{/snippet}
			</PageHeader>

			<div class="grid gap-4 lg:grid-cols-3">
				<Card.Root>
					<Card.Header>
						<Card.Description>Issue</Card.Description>
						<Card.Title class="font-mono text-base">{d.issueKey}</Card.Title>
					</Card.Header>
					<Card.Content>
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
							<dt class="text-muted-foreground">Author</dt>
							<dd>{d.issue?.author ?? '—'}</dd>
							<dt class="text-muted-foreground">Association</dt>
							<dd class="font-mono text-xs leading-5">{d.issue?.association ?? '—'}</dd>
							<dt class="text-muted-foreground">Repository id</dt>
							<dd class="tabular-nums">{d.repoId}</dd>
							<dt class="text-muted-foreground">Number</dt>
							<dd class="tabular-nums">#{d.number}</dd>
						</dl>
					</Card.Content>
				</Card.Root>

				<Card.Root data-testid="verdict-card">
					<Card.Header>
						<Card.Description>Verdict</Card.Description>
						<Card.Title>
							{#if d.verdict}<StateBadge state={d.verdict.verdict} class="h-6 px-2.5 text-sm" />{:else}<span class="text-muted-foreground text-base font-normal">Not decided yet</span>{/if}
						</Card.Title>
					</Card.Header>
					{#if d.verdict}
						<Card.Content>
							<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
								<dt class="text-muted-foreground">Reason</dt>
								<dd class="font-mono text-xs leading-5 break-all">{d.verdict.reason}</dd>
								<dt class="text-muted-foreground">Decided</dt>
								<dd><RelativeTime ms={d.verdict.decidedAt} /></dd>
							</dl>
						</Card.Content>
					{/if}
				</Card.Root>

				<Card.Root data-testid="effect-card">
					<Card.Header>
						<Card.Description>Outbox effect</Card.Description>
						<Card.Title>
							{#if d.effect}<StateBadge state={d.effect.state} class="h-6 px-2.5 text-sm" />{:else}<span class="text-muted-foreground text-base font-normal">None</span>{/if}
						</Card.Title>
						{#if d.effect?.state === 'dead'}
							<Card.Action>
								<RetryEffectButton effectKey={d.effect.effectKey} updates={() => [issue]} size="sm" />
							</Card.Action>
						{/if}
					</Card.Header>
					{#if d.effect}
						<Card.Content>
							<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
								<dt class="text-muted-foreground">Key</dt>
								<dd class="font-mono text-xs leading-5 break-all">{d.effect.effectKey}</dd>
								<dt class="text-muted-foreground">Attempts</dt>
								<dd class="tabular-nums">{d.effect.attempts}</dd>
								<dt class="text-muted-foreground">Next attempt</dt>
								<dd><RelativeTime ms={d.effect.nextAttemptAt} /></dd>
								<dt class="text-muted-foreground">Comment id</dt>
								<dd class="tabular-nums">{d.effect.commentId ?? '—'}</dd>
								<dt class="text-muted-foreground">Updated</dt>
								<dd><RelativeTime ms={d.effect.updatedAt} /></dd>
								<dt class="text-muted-foreground">Last error</dt>
								<dd class="font-mono text-xs leading-5 break-all {d.effect.lastError ? 'text-red-700 dark:text-red-400' : ''}">{d.effect.lastError ?? '—'}</dd>
							</dl>
						</Card.Content>
					{/if}
				</Card.Root>
			</div>

			<Card.Root>
				<Card.Header>
					<Card.Title>Inbox deliveries</Card.Title>
					<Card.Description>Every webhook delivery stored for this issue, newest first.</Card.Description>
				</Card.Header>
				<Card.Content class="px-0">
					<Table.Root>
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head class="pl-6">Delivery id</Table.Head>
								<Table.Head>Event</Table.Head>
								<Table.Head>State</Table.Head>
								<Table.Head class="pr-6 text-right">Received</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each d.deliveries as del (del.deliveryId)}
								<Table.Row>
									<Table.Cell class="pl-6 font-mono text-xs">{del.deliveryId}</Table.Cell>
									<Table.Cell class="font-mono text-xs">{del.event}{del.action ? `.${del.action}` : ''}</Table.Cell>
									<Table.Cell><StateBadge state={del.state} /></Table.Cell>
									<Table.Cell class="text-muted-foreground pr-6 text-right text-sm"><RelativeTime ms={del.receivedAt} /></Table.Cell>
								</Table.Row>
							{:else}
								<Table.Row><Table.Cell colspan={4} class="text-muted-foreground py-8 text-center">No inbox rows.</Table.Cell></Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Card.Content>
			</Card.Root>

			<ActorPanel actor={d.actor} address="issue/{d.issueKey}" onrefresh={() => issue.refresh()} refreshing={issue.loading} />

			{#if d.effect}
				<Card.Root>
					<Card.Header>
						<Card.Title>Effect payload</Card.Title>
						<Card.Description>The <code>github.close</code> data stored in the outbox row; replies go to <code>{d.effect.replyTo.family}/{d.effect.replyTo.name}</code>.</Card.Description>
					</Card.Header>
					<Card.Content><JsonView value={d.effect.payload} /></Card.Content>
				</Card.Root>
			{/if}
		{/if}

		{#snippet failed(error, reset)}
			<PageHeader title="Issue {key}" />
			<ErrorAlert {error} retry={() => { void issue.refresh(); reset(); }} />
		{/snippet}
	</svelte:boundary>
{/if}
