<!--
	One item — an issue or a pull request (ADR 0291): what granary decided,
	the GitHub action (comment + close) with the posted comment, and every
	delivery. Admins get links into /admin for the actor and its traces.
-->
<script lang="ts">
	import { page } from '$app/state';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import WaypointsIcon from '@lucide/svelte/icons/waypoints';
	import { getIssue } from '$lib/remote/dashboard.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import RetryEffectButton from '$lib/components/app/RetryEffectButton.svelte';
	import { ISSUE_KEY_RE, issueLabel } from '$lib/components/app/format';
	import { ACTION_LABELS, DELIVERY_LABELS, KIND_LABELS, OUTCOME_LABELS, reasonLabel } from '$lib/components/app/glossary';
	import { canSeeAdmin } from '$lib/components/app/session';
	import { actorHref } from '$lib/components/actors/inspect';

	const key = $derived(page.params.key ?? '');
	const valid = $derived(ISSUE_KEY_RE.test(key));
	const issue = $derived(valid ? getIssue({ issueKey: key }) : null);
	const admin = $derived(canSeeAdmin());
</script>

{#if !issue}
	<PageHeader title="Item {key}" />
	<Alert.Root variant="destructive">
		<CircleAlertIcon />
		<Alert.Title>Not an item key</Alert.Title>
		<Alert.Description>Item keys look like <code>&lt;repository id&gt;-&lt;number&gt;</code>, e.g. <code>700001-3</code>.</Alert.Description>
	</Alert.Root>
{:else}
	<svelte:boundary>
		{@const d = await issue}
		{#if !d}
			<PageHeader title="Item {key}" />
			<Alert.Root>
				<CircleAlertIcon />
				<Alert.Title>Unknown item</Alert.Title>
				<Alert.Description>granary has not seen an issue or pull request with the key <code>{key}</code>.</Alert.Description>
			</Alert.Root>
		{:else}
			{@const kind = d.issue?.kind ?? 'issue'}
			{@const commentBody = d.effect?.payload && 'commentBody' in d.effect.payload ? (d.effect.payload as { commentBody?: string }).commentBody : undefined}
			<PageHeader
				title={d.issue ? `${KIND_LABELS[kind]} ${issueLabel(d.issue)}` : `Item ${d.issueKey}`}
				description={d.issue?.title ?? `Repository ${d.repoId}, #${d.number}`}
			>
				{#snippet actions()}
					{#if d.issue}
						<Button href={d.issue.htmlUrl} target="_blank" rel="noreferrer" variant="ghost" size="sm"><ExternalLinkIcon /> On GitHub</Button>
					{/if}
					{#if admin}
						<Button href={actorHref({ family: 'issue', name: d.issueKey })} variant="ghost" size="sm" data-testid="inspect-actor-link"><CpuIcon /> Inspect actor</Button>
						<Button href="/admin/traces" variant="ghost" size="sm"><WaypointsIcon /> Traces</Button>
					{/if}
					<Button variant="outline" size="sm" onclick={() => issue.refresh()} disabled={issue.loading}>
						<RefreshCwIcon class={issue.loading ? 'animate-spin' : ''} /> Refresh
					</Button>
				{/snippet}
			</PageHeader>

			<div class="grid gap-4 lg:grid-cols-3">
				<Card.Root>
					<Card.Header>
						<Card.Description>{KIND_LABELS[kind]}</Card.Description>
						<Card.Title class="text-base">{d.issue ? issueLabel(d.issue) : d.issueKey}</Card.Title>
					</Card.Header>
					<Card.Content>
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
							<dt class="text-muted-foreground">Author</dt>
							<dd>{d.issue?.author ?? '—'}</dd>
							{#if d.issue && d.issue.association !== 'NONE'}
								<dt class="text-muted-foreground">Role</dt>
								<dd class="text-sm">{d.issue.association.toLowerCase().replaceAll('_', ' ')}</dd>
							{/if}
						</dl>
					</Card.Content>
				</Card.Root>

				<Card.Root data-testid="verdict-card">
					<Card.Header>
						<Card.Description>Decision</Card.Description>
						<Card.Title>
							{#if d.verdict}<StateBadge state={d.verdict.verdict} label={OUTCOME_LABELS[d.verdict.verdict]} class="h-6 px-2.5 text-sm" />{:else}<span class="text-muted-foreground text-base font-normal">Not decided yet</span>{/if}
						</Card.Title>
					</Card.Header>
					{#if d.verdict}
						<Card.Content>
							<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
								<dt class="text-muted-foreground">Why</dt>
								<dd>{reasonLabel(d.verdict.reason)}</dd>
								<dt class="text-muted-foreground">Decided</dt>
								<dd><RelativeTime ms={d.verdict.decidedAt} /></dd>
							</dl>
						</Card.Content>
					{/if}
				</Card.Root>

				<Card.Root data-testid="effect-card">
					<Card.Header>
						<Card.Description>GitHub action</Card.Description>
						<Card.Title>
							{#if d.effect}<StateBadge state={d.effect.state} label={ACTION_LABELS[d.effect.state]} class="h-6 px-2.5 text-sm" />{:else}<span class="text-muted-foreground text-base font-normal">None</span>{/if}
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
								<dt class="text-muted-foreground">Attempts</dt>
								<dd class="tabular-nums">{d.effect.attempts}</dd>
								{#if d.effect.state !== 'done' && d.effect.nextAttemptAt}
									<dt class="text-muted-foreground">Next attempt</dt>
									<dd><RelativeTime ms={d.effect.nextAttemptAt} /></dd>
								{/if}
								<dt class="text-muted-foreground">Comment</dt>
								<dd>
									{#if d.effect.commentId && d.issue}
										<a href="{d.issue.htmlUrl}#issuecomment-{d.effect.commentId}" target="_blank" rel="noreferrer" class="underline-offset-4 hover:underline">View on GitHub</a>
									{:else}—{/if}
								</dd>
								<dt class="text-muted-foreground">Updated</dt>
								<dd><RelativeTime ms={d.effect.updatedAt} /></dd>
								{#if d.effect.lastError}
									<dt class="text-muted-foreground">Last error</dt>
									<dd class="text-xs leading-5 break-all text-red-700 dark:text-red-400">{d.effect.lastError}</dd>
								{/if}
							</dl>
						</Card.Content>
					{/if}
				</Card.Root>
			</div>

			{#if commentBody}
				<Card.Root data-testid="comment-card">
					<Card.Header>
						<Card.Title>Comment</Card.Title>
						<Card.Description>What granary posts before closing (a hidden marker is appended).</Card.Description>
					</Card.Header>
					<Card.Content><div class="bg-muted/50 rounded-md border p-3 text-sm whitespace-pre-wrap">{commentBody}</div></Card.Content>
				</Card.Root>
			{/if}

			<Card.Root>
				<Card.Header>
					<Card.Title>Deliveries</Card.Title>
					<Card.Description>Every webhook GitHub sent about this {kind === 'pull_request' ? 'pull request' : 'issue'}, newest first.</Card.Description>
				</Card.Header>
				<Card.Content class="px-0">
					<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head class="pl-6">Event</Table.Head>
								<Table.Head>State</Table.Head>
								<Table.Head>Delivery</Table.Head>
								<Table.Head class="pr-6 text-right">Received</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each d.deliveries as del (del.deliveryId)}
								<Table.Row>
									<Table.Cell class="pl-6 font-mono text-xs">{del.event}{del.action ? `.${del.action}` : ''}</Table.Cell>
									<Table.Cell>
										<StateBadge state={del.state} label={DELIVERY_LABELS[del.state]} />
										{#if del.ignoreReason}<span class="text-muted-foreground mt-0.5 block text-xs">{del.ignoreReason}</span>{/if}
									</Table.Cell>
									<Table.Cell class="text-muted-foreground font-mono text-xs" title={del.deliveryId}>{del.deliveryId.slice(0, 8)}</Table.Cell>
									<Table.Cell class="text-muted-foreground pr-6 text-right text-sm"><RelativeTime ms={del.receivedAt} /></Table.Cell>
								</Table.Row>
							{:else}
								<Table.Row><Table.Cell colspan={4} class="text-muted-foreground py-8 text-center">No deliveries stored.</Table.Cell></Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
					</div>
				</Card.Content>
			</Card.Root>

			{#if admin && d.effect}
				<Card.Root>
					<Card.Header>
						<Card.Title>Stored action data</Card.Title>
						<Card.Description>The outbox row's payload, for debugging.</Card.Description>
					</Card.Header>
					<Card.Content><JsonBlock value={d.effect.payload} preset="compact" rootLabel="payload" title="Action payload" alwaysTree /></Card.Content>
				</Card.Root>
			{/if}
		{/if}

		{#snippet failed(error, reset)}
			<PageHeader title="Item {key}" />
			<ErrorAlert {error} retry={() => { void issue.refresh(); reset(); }} />
		{/snippet}
	</svelte:boundary>
{/if}
