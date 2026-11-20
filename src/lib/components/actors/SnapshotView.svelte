<!-- Everything an ActorSnapshot says about one actor (ADR 0056, ADR 0300). -->
<script lang="ts">
	import type { ActorSnapshot } from '$lib/schemas/api';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import { issueHref } from '$lib/components/app/format';
	import ChartTree from './ChartTree.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';

	let { snap, compact = false }: { snap: ActorSnapshot; compact?: boolean } = $props();
	const hasHistory = $derived(snap.history !== null && typeof snap.history === 'object' && Object.keys(snap.history).length > 0);
</script>

<div class="grid gap-4 {compact ? '' : 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'}" data-testid="actor-snapshot">
	<!-- Identity -->
	<Card.Root class={compact ? '' : 'xl:col-span-2'}>
		<Card.Header>
			<Card.Title>Identity &amp; state</Card.Title>
			<Card.Description>Snapshot taken <RelativeTime ms={snap.capturedAt} /></Card.Description>
		</Card.Header>
		<Card.Content>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
				<dt class="text-muted-foreground">Address</dt>
				<dd class="font-mono text-xs leading-5">{snap.id}</dd>
				<dt class="text-muted-foreground">Session</dt>
				<dd class="font-mono text-xs leading-5">{snap.sessionId}</dd>
				<dt class="text-muted-foreground">Chart</dt>
				<dd class="font-mono text-xs leading-5" title="The host segment of the chart's image">{snap.family} · v{snap.segment}{snap.chart ? ` · ${snap.chart.revision}` : ''}</dd>
				<dt class="text-muted-foreground">Active states</dt>
				<dd class="flex flex-wrap items-start gap-1 self-start">
					{#each snap.activeStates as s (s)}<span class="bg-primary/10 text-primary rounded px-1.5 font-mono text-xs leading-5">{s}</span>{:else}—{/each}
				</dd>
				<dt class="text-muted-foreground">Mailbox</dt>
				<dd class="text-xs leading-5 tabular-nums" data-testid="actor-mailbox">{snap.mailboxDepth} event{snap.mailboxDepth === 1 ? '' : 's'} waiting</dd>
				<dt class="text-muted-foreground">Services</dt>
				<dd class="text-xs leading-5 tabular-nums">{snap.invocations}</dd>
				{#if snap.issueKey}
					<dt class="text-muted-foreground">Issue</dt>
					<dd class="text-xs leading-5"><a class="underline underline-offset-4" href={issueHref(snap.issueKey)}>{snap.issueKey}</a></dd>
				{/if}
			</dl>
		</Card.Content>
	</Card.Root>

	<!-- Chart -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Statechart</Card.Title>
			<Card.Description>States and transitions of the chart; the active configuration is highlighted.</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if snap.chart}
				<ChartTree chart={snap.chart} active={snap.activeStates} finalState={null} />
			{:else}
				<p class="text-muted-foreground text-sm">No chart structure known for {snap.family}.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- sticky beside a long statechart, so the right column doesn't sit empty -->
	<div class="grid content-start gap-4 {compact ? '' : 'xl:sticky xl:top-20 xl:self-start'}">
		<!-- Data -->
		<Card.Root>
			<Card.Header>
				<Card.Title>Data model</Card.Title>
				<Card.Description>The actor's variables (a copy).</Card.Description>
			</Card.Header>
			<Card.Content>
				<div data-testid="actor-data">
					<JsonBlock value={snap.data} preset="panel" rootLabel="data" title={snap.address ? `${snap.address.family}/${snap.address.name} data` : 'data'} alwaysTree fullscreen={!compact} />
				</div>
				{#if hasHistory}
					<h3 class="mt-3 mb-1 text-sm font-medium">History states</h3>
					<JsonBlock value={snap.history} preset="compact" rootLabel="history" fullscreen={!compact} />
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<!-- Delayed sends -->
	<Card.Root class={compact ? '' : 'xl:col-span-2'}>
		<Card.Header>
			<Card.Title>Pending delayed sends <span class="text-muted-foreground font-normal">({snap.delayedSends.length})</span></Card.Title>
			<Card.Description>Timers and deferred sends, by due time.</Card.Description>
		</Card.Header>
		<Card.Content class="px-0">
			<Table.Root stack>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head class="pl-6">Event</Table.Head>
						<Table.Head>Send id</Table.Head>
						<Table.Head class="pr-6">Due</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each snap.delayedSends as d, i (d.id ?? i)}
						<Table.Row>
							<Table.Cell class="pl-6 font-mono text-xs">{d.event}</Table.Cell>
							<Table.Cell class="font-mono text-xs">{d.id ?? '—'}</Table.Cell>
							<Table.Cell class="pr-6 text-xs"><RelativeTime ms={d.due} /></Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row class="hover:bg-transparent">
							<Table.Cell colspan={3} class="text-muted-foreground py-6 text-center text-sm">No pending delayed sends.</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
</div>
