<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { listActors } from '$lib/remote/actors.remote';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import TableSkeleton from '$lib/components/app/TableSkeleton.svelte';
	import { formatBytes, issueHref } from '$lib/components/app/format';
	import ActorQuickView from '$lib/components/actors/ActorQuickView.svelte';
	import { actorHref } from '$lib/components/actors/inspect';

	const actors = listActors();
	let auto = $state(false);

	$effect(() => {
		if (!auto) return;
		const id = setInterval(() => void actors.refresh(), 2000);
		return () => clearInterval(id);
	});
</script>

<section class="space-y-3" aria-labelledby="granary-actors-heading">
<div class="flex flex-wrap items-end justify-between gap-3">
	<div>
		<h2 id="granary-actors-heading" class="text-lg font-semibold">granary</h2>
		<p class="text-muted-foreground text-sm">Actors resident in granary's actor system. Click one to inspect it.</p>
	</div>
	<div class="flex items-center gap-3">
		<div class="flex items-center gap-2">
			<Switch id="auto-refresh" bind:checked={auto} />
			<Label for="auto-refresh" class="text-sm">Auto-refresh (2 s)</Label>
		</div>
		<Button variant="outline" size="sm" onclick={() => actors.refresh()} disabled={actors.loading && !auto}>
			<RefreshCwIcon class={actors.loading ? 'animate-spin' : ''} /> Refresh
		</Button>
	</div>
</div>

<div class="bg-card overflow-x-auto rounded-xl border">
	<svelte:boundary>
		{@const list = await actors}
		<Table.Root>
			<Table.Header>
				<Table.Row class="hover:bg-transparent">
					<Table.Head>Address</Table.Head>
					<Table.Head>Active states</Table.Head>
					<Table.Head>Scheduling</Table.Head>
					<Table.Head>Residency</Table.Head>
					<Table.Head class="text-right">Step</Table.Head>
					<Table.Head class="text-right">Mailbox</Table.Head>
					<Table.Head class="text-right">Delayed</Table.Head>
					<Table.Head class="text-right">Memory</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each list as a (a.id)}
					<Table.Row data-testid="actor-row">
						<Table.Cell class="font-mono text-xs">
							<div class="flex items-center gap-1.5">
								{#if a.address}
									<a href={actorHref(a.address)} class="font-medium underline-offset-4 hover:underline" data-testid="actor-inspect-link">{a.id}</a>
									<ActorQuickView address={a.address} />
									{#if a.address.family === 'issue'}
										<a href={issueHref(a.address.name)} class="text-muted-foreground font-sans underline-offset-4 hover:underline">issue</a>
									{/if}
								{:else}
									{a.id}
								{/if}
							</div>
						</Table.Cell>
						<Table.Cell>
							<div class="flex flex-wrap gap-1">
								{#each a.activeStates as s (s)}<span class="bg-muted rounded px-1.5 font-mono text-xs leading-5">{s}</span>{/each}
								{#if a.finalState}<span class="text-muted-foreground text-xs">final: {a.finalState}</span>{/if}
							</div>
						</Table.Cell>
						<Table.Cell><StateBadge state={a.scheduling} /></Table.Cell>
						<Table.Cell><StateBadge state={a.residency} /></Table.Cell>
						<Table.Cell class="text-right font-mono text-xs">
							{a.macrostep}.{a.microstep}{a.macrostepInProgress ? '*' : ''}
						</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{a.mailboxDepth}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{a.delayedSendCount}</Table.Cell>
						<Table.Cell class="text-muted-foreground text-right text-xs tabular-nums">{formatBytes(a.allocatedBytes)}</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row class="hover:bg-transparent">
						<Table.Cell colspan={8} class="text-muted-foreground py-10 text-center">No resident actors.</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
		{#snippet failed(error, reset)}
			<div class="p-4"><ErrorAlert {error} retry={() => { void actors.refresh(); reset(); }} /></div>
		{/snippet}
	</svelte:boundary>
</div>
</section>
