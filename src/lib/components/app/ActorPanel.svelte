<!-- Live inspection of one actor (ActorDetail), with a Refresh button. -->
<script lang="ts">
	import type { ActorDetail } from '$lib/schemas/api';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import ScanSearchIcon from '@lucide/svelte/icons/scan-search';
	import StateBadge from './StateBadge.svelte';
	import RelativeTime from './RelativeTime.svelte';
	import JsonView from './JsonView.svelte';
	import { formatBytes } from './format';

	let {
		actor,
		address,
		onrefresh,
		refreshing = false
	}: { actor: ActorDetail | null; address: string; onrefresh: () => void; refreshing?: boolean } = $props();
</script>

<Card.Root data-testid="actor-panel">
	<Card.Header>
		<Card.Title class="flex items-center gap-2"><CpuIcon class="size-4" /> Live actor</Card.Title>
		<Card.Description class="font-mono">{address}</Card.Description>
		<Card.Action class="flex items-center gap-2">
			{#if actor}
				<Button variant="outline" size="sm" href="/actors/{address.split('/').map(encodeURIComponent).join('/')}" data-testid="open-inspector">
					<ScanSearchIcon /> Inspect
				</Button>
			{/if}
			<Button variant="outline" size="sm" onclick={onrefresh} disabled={refreshing}>
				<RefreshCwIcon class={refreshing ? 'animate-spin' : ''} /> Refresh
			</Button>
		</Card.Action>
	</Card.Header>
	<Card.Content>
		{#if !actor}
			<p class="text-muted-foreground text-sm">
				Not resident. The actor is loaded on demand when an event arrives and leaves memory when it
				is done.
			</p>
		{:else}
			<div class="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
				<dl class="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-2 text-sm">
					<dt class="text-muted-foreground">Active states</dt>
					<dd class="flex flex-wrap gap-1">
						{#each actor.activeStates as s (s)}<span class="bg-muted rounded px-1.5 font-mono text-xs leading-5">{s}</span>{:else}—{/each}
					</dd>
					<dt class="text-muted-foreground">Residency</dt>
					<dd><StateBadge state={actor.residency} /></dd>
					<dt class="text-muted-foreground">Scheduling</dt>
					<dd><StateBadge state={actor.scheduling} /></dd>
					<dt class="text-muted-foreground">Step</dt>
					<dd class="font-mono text-xs leading-5">
						macro {actor.macrostep} · micro {actor.microstep}{actor.macrostepInProgress ? ' · in progress' : ''}
					</dd>
					<dt class="text-muted-foreground">Current event</dt>
					<dd class="font-mono text-xs leading-5">{actor.currentEvent ?? '—'}</dd>
					<dt class="text-muted-foreground">Final state</dt>
					<dd class="font-mono text-xs leading-5">{actor.finalState ?? '—'}</dd>
					<dt class="text-muted-foreground">Mailbox</dt>
					<dd class="tabular-nums">{actor.mailboxDepth}</dd>
					<dt class="text-muted-foreground">Memory</dt>
					<dd class="tabular-nums">{formatBytes(actor.allocatedBytes)}</dd>
					<dt class="text-muted-foreground">Revision</dt>
					<dd class="font-mono text-xs leading-5">{actor.revision} · session {actor.sessionId}</dd>
				</dl>
				<div class="min-w-0 space-y-4">
					<div>
						<h3 class="mb-1.5 text-sm font-medium">Data</h3>
						<JsonView value={actor.data} class="max-h-80" />
					</div>
					{#if actor.delayedSends.length}
						<div>
							<h3 class="mb-1.5 text-sm font-medium">Delayed sends</h3>
							<ul class="space-y-1 text-sm">
								{#each actor.delayedSends as ds, i (ds.id ?? i)}
									<li class="flex items-center gap-2">
										<span class="font-mono text-xs">{ds.event}</span>
										{#if ds.id}<span class="text-muted-foreground text-xs">({ds.id})</span>{/if}
										<span class="text-muted-foreground ml-auto text-xs">due <RelativeTime ms={ds.due} /></span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if actor.mailbox.length}
						<div>
							<h3 class="mb-1.5 text-sm font-medium">Mailbox</h3>
							<JsonView value={actor.mailbox} class="max-h-60" />
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
