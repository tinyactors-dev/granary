<!-- Actor inspector (ADR 0056): a live or frozen snapshot of one actor's inside. -->
<script lang="ts">
	import { page } from '$app/state';
	import type { ActorSnapshot } from '$lib/schemas/api';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import CameraIcon from '@lucide/svelte/icons/camera';
	import XIcon from '@lucide/svelte/icons/x';
	import { inspectActor } from '$lib/remote/actors.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { absoluteTime } from '$lib/components/app/format';
	import SnapshotView from '$lib/components/actors/SnapshotView.svelte';
	import ActorGone from '$lib/components/actors/ActorGone.svelte';
	import DataDiff from '$lib/components/actors/DataDiff.svelte';

	const LIVE_MS = 1500;

	const address = $derived({ family: page.params.family ?? '', name: page.params.name ?? '' });
	const snap = $derived(inspectActor({ address }));

	let live = $state(true);
	let frozen = $state<ActorSnapshot | null>(null);
	let showFrozen = $state(false);

	$effect(() => {
		if (!live) return;
		const q = snap;
		const id = setInterval(() => void q.refresh(), LIVE_MS);
		return () => clearInterval(id);
	});

	// A new address drops the frozen snapshot of the previous one.
	$effect(() => {
		void address.family;
		void address.name;
		frozen = null;
		showFrozen = false;
	});

	function capture() {
		const current = snap.current;
		if (!current) return;
		frozen = structuredClone($state.snapshot(current)) as ActorSnapshot;
	}
</script>

<PageHeader title="{address.family}/{address.name}" description="Actor inspector: chart, active configuration, data model, queues and timers.">
	{#snippet actions()}
		<div class="flex items-center gap-2">
			<Switch id="live" bind:checked={live} />
			<Label for="live" class="text-sm">Live ({LIVE_MS / 1000} s)</Label>
		</div>
		<Button variant="outline" size="sm" onclick={() => snap.refresh()} disabled={snap.loading && !live}>
			<RefreshCwIcon class={snap.loading ? 'animate-spin' : ''} /> Refresh
		</Button>
		<Button size="sm" onclick={capture} disabled={!snap.current} data-testid="capture-snapshot">
			<CameraIcon /> Capture snapshot
		</Button>
	{/snippet}
</PageHeader>

<div class="mt-6 space-y-4">
	<svelte:boundary>
		{@const current = await snap}
		{#if frozen}
			<Card.Root data-testid="frozen-snapshot">
				<Card.Header>
					<Card.Title>Captured {absoluteTime(frozen.capturedAt)}</Card.Title>
					<Card.Description>
						Changes between the captured snapshot and {current ? 'the live actor' : 'now (the actor is gone)'}.
					</Card.Description>
					<Card.Action class="flex items-center gap-2">
						<div class="flex items-center gap-2">
							<Switch id="show-frozen" bind:checked={showFrozen} />
							<Label for="show-frozen" class="text-sm">Show captured</Label>
						</div>
						<Button variant="ghost" size="icon" class="size-8" aria-label="Discard snapshot" onclick={() => { frozen = null; showFrozen = false; }}>
							<XIcon />
						</Button>
					</Card.Action>
				</Card.Header>
				<Card.Content>
					{#if current}
						<DataDiff before={frozen} after={current} />
					{:else}
						<p class="text-muted-foreground text-sm">The actor is no longer resident; the captured snapshot is all that is left.</p>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if showFrozen && frozen}
			<SnapshotView snap={frozen} />
		{:else if current}
			<SnapshotView snap={current} />
		{:else}
			<ActorGone family={address.family} name={address.name} />
			{#if frozen}<SnapshotView snap={frozen} />{/if}
		{/if}

		{#snippet failed(error, reset)}
			<ErrorAlert {error} retry={() => { void snap.refresh(); reset(); }} />
		{/snippet}
	</svelte:boundary>
</div>
