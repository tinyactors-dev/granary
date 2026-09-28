<!-- Everything an ActorSnapshot says about one actor (ADR 0056). -->
<script lang="ts">
	import type { ActorSnapshot, SnapshotEvent } from '$lib/schemas/api';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import { formatBytes, issueHref } from '$lib/components/app/format';
	import ChartTree from './ChartTree.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import { inlineJson } from './inspect';

	let { snap, compact = false }: { snap: ActorSnapshot; compact?: boolean } = $props();
</script>

{#snippet eventRow(e: SnapshotEvent)}
	<div class="rounded-md border p-2 text-xs">
		<div class="flex flex-wrap items-center gap-2">
			<span class="font-mono font-medium">{e.name}</span>
			<span class="bg-muted rounded px-1.5 leading-5">{e.type}</span>
			{#if e.sendId}<span class="text-muted-foreground">send id {e.sendId}</span>{/if}
			{#if e.origin}<span class="text-muted-foreground ml-auto font-mono">from {e.origin}</span>{/if}
		</div>
		{#if e.data !== null}<div class="mt-1"><JsonBlock value={e.data} preset="inline" rootLabel="data" title="{e.name} data" fullscreen={!compact} /></div>{/if}
	</div>
{/snippet}

<div class="grid gap-4 {compact ? '' : 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'}" data-testid="actor-snapshot">
	<!-- Identity -->
	<Card.Root class={compact ? '' : 'xl:col-span-2'}>
		<Card.Header>
			<Card.Title>Identity &amp; scheduling</Card.Title>
			<Card.Description>Snapshot taken <RelativeTime ms={snap.capturedAt} /></Card.Description>
		</Card.Header>
		<Card.Content>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
				<dt class="text-muted-foreground">Address</dt>
				<dd class="font-mono text-xs leading-5">{snap.id}</dd>
				<dt class="text-muted-foreground">Session</dt>
				<dd class="font-mono text-xs leading-5">{snap.sessionId}</dd>
				<dt class="text-muted-foreground">Runtime ID</dt>
				<dd class="font-mono text-xs leading-5">slot {snap.runtime.slot} · gen {snap.runtime.generation}</dd>
				<dt class="text-muted-foreground">Definition</dt>
				<dd class="font-mono text-xs leading-5">
					{snap.definition.family}@{snap.definition.revision} · #{snap.definition.id}{snap.definition.retired ? ' · retired' : ''}
				</dd>
				<dt class="text-muted-foreground">Chart</dt>
				<dd class="text-xs leading-5">
					{snap.definition.stateCount} states · {snap.definition.datamodel} · {snap.definition.binding} binding ·
					{snap.definition.actorCount} actor{snap.definition.actorCount === 1 ? '' : 's'}
				</dd>
				<dt class="text-muted-foreground">Active states</dt>
				<dd class="flex flex-wrap items-start gap-1 self-start">
					{#each snap.activeStates as s (s)}<span class="bg-primary/10 text-primary rounded px-1.5 font-mono text-xs leading-5">{s}</span>{:else}—{/each}
				</dd>
				<dt class="text-muted-foreground">Residency</dt>
				<dd><StateBadge state={snap.residency} /></dd>
				<dt class="text-muted-foreground">Scheduling</dt>
				<dd><StateBadge state={snap.scheduling} /></dd>
				<dt class="text-muted-foreground">Published</dt>
				<dd class="text-xs leading-5">{snap.published ? 'yes' : 'no (prepared replacement)'}</dd>
				<dt class="text-muted-foreground">Step</dt>
				<dd class="font-mono text-xs leading-5">
					macro {snap.macrostep} · micro {snap.microstep}{snap.macrostepInProgress ? ' · macrostep running' : ''}{snap.microstepInProgress ? ' · paused in microstep' : ''}
				</dd>
				<dt class="text-muted-foreground">Position</dt>
				<dd class="font-mono text-xs leading-5">
					{#if snap.position.at === 'none'}between macrosteps{:else}{snap.position.at}{snap.position.state ? ` in ${snap.position.state}` : ''}{snap.position.transition !== null ? ` · transition #${snap.position.transition}` : ''}{snap.position.action !== null ? ` · action #${snap.position.action}` : ''}{/if}
				</dd>
				<dt class="text-muted-foreground">Final state</dt>
				<dd class="font-mono text-xs leading-5">{snap.finalState ?? '—'}</dd>
				<dt class="text-muted-foreground">Memory</dt>
				<dd class="text-xs leading-5 tabular-nums">{formatBytes(snap.allocatedBytes)}</dd>
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
			<Card.Description>States and transitions of the definition; the active configuration is highlighted.</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if snap.chart}
				<ChartTree chart={snap.chart} active={snap.activeStates} finalState={snap.finalState} />
			{:else}
				<p class="text-muted-foreground text-sm">No chart structure known for {snap.definition.family}@{snap.definition.revision}.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="grid content-start gap-4">
		<!-- Data -->
		<Card.Root>
			<Card.Header>
				<Card.Title>Data model</Card.Title>
				<Card.Description>Live data root (JSON-safe copy).</Card.Description>
			</Card.Header>
			<Card.Content>
				<div data-testid="actor-data">
					<JsonBlock value={snap.data} preset="panel" rootLabel="data" title={snap.address ? `${snap.address.family}/${snap.address.name} data` : 'data'} alwaysTree fullscreen={!compact} />
				</div>
				{#if snap.completion !== null}
					<h3 class="mt-3 mb-1 text-sm font-medium">Completion (donedata)</h3>
					<JsonBlock value={snap.completion} preset="compact" rootLabel="completion" fullscreen={!compact} />
				{/if}
			</Card.Content>
		</Card.Root>

		<!-- Queues -->
		<Card.Root>
			<Card.Header>
				<Card.Title>Events &amp; queues</Card.Title>
				<Card.Description>Current event, internal queue and the external mailbox (oldest first).</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3 text-sm">
				<div>
					<h3 class="mb-1 font-medium">Current event</h3>
					{#if snap.currentEvent}{@render eventRow(snap.currentEvent)}{:else}<p class="text-muted-foreground text-xs">None — idle between macrosteps.</p>{/if}
				</div>
				<div>
					<h3 class="mb-1 font-medium">Internal queue <span class="text-muted-foreground font-normal">({snap.internalEvents.length})</span></h3>
					{#each snap.internalEvents as e, i (i)}{@render eventRow(e)}{:else}<p class="text-muted-foreground text-xs">Empty.</p>{/each}
				</div>
				<div data-testid="actor-mailbox">
					<h3 class="mb-1 font-medium">
						Mailbox <span class="text-muted-foreground font-normal">({snap.mailboxDepth}{snap.mailboxTruncated ? '+' : ''})</span>
					</h3>
					{#each snap.mailbox as m, i (i)}
						<div class="mb-1 rounded-md border p-2 text-xs">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-muted-foreground tabular-nums">#{i + 1}</span>
								<span class="font-mono font-medium">{m.event}</span>
								{#if m.awaited}<span class="bg-muted rounded px-1.5 leading-5">awaited</span>{/if}
								{#if m.transition}<span class="bg-muted rounded px-1.5 font-mono leading-5">goto {m.transition}</span>{/if}
							</div>
							{#if m.data !== null}<div class="mt-1"><JsonBlock value={m.data} preset="inline" rootLabel="data" title="{m.event} data" fullscreen={!compact} /></div>{/if}
						</div>
					{:else}
						<p class="text-muted-foreground text-xs">Empty.</p>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	</div>

	<!-- Delayed sends & invocations -->
	<Card.Root class={compact ? '' : 'xl:col-span-2'}>
		<Card.Header>
			<Card.Title>Pending delayed sends <span class="text-muted-foreground font-normal">({snap.delayedSends.length})</span></Card.Title>
			<Card.Description>Timers and deferred sends, by due time.</Card.Description>
		</Card.Header>
		<Card.Content class="px-0">
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head class="pl-6">Event</Table.Head>
						<Table.Head>Send id</Table.Head>
						<Table.Head>Due</Table.Head>
						<Table.Head>Destination</Table.Head>
						<Table.Head>I/O type</Table.Head>
						<Table.Head class="pr-6">Data</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each snap.delayedSends as d, i (d.id ?? i)}
						<Table.Row>
							<Table.Cell class="pl-6 font-mono text-xs">{d.event}{d.submitted ? ' (refused once)' : ''}</Table.Cell>
							<Table.Cell class="font-mono text-xs">{d.id ?? '—'}</Table.Cell>
							<Table.Cell class="text-xs"><RelativeTime ms={d.due} /></Table.Cell>
							<Table.Cell class="font-mono text-xs">{d.destination ?? inlineJson(d.target, 40)}</Table.Cell>
							<Table.Cell class="text-muted-foreground max-w-48 truncate font-mono text-xs" title={d.ioType}>{d.ioType}</Table.Cell>
							<Table.Cell class="max-w-72 truncate pr-6 font-mono text-xs" title={inlineJson(d.data, 1000)}>{inlineJson(d.data)}</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row class="hover:bg-transparent">
							<Table.Cell colspan={6} class="text-muted-foreground py-6 text-center text-sm">No pending delayed sends.</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#if snap.invocations.length}
				<div class="mt-4 px-6">
					<h3 class="mb-1 text-sm font-medium">Invocations</h3>
					<ul class="space-y-1 font-mono text-xs">
						{#each snap.invocations as v (v.id)}
							<li>#{v.id} {v.type} · {v.active ? 'active' : 'finished'}{v.autoforward ? ' · autoforward' : ''} · handle {v.serviceHandle}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
