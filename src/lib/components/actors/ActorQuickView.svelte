<!-- Dialog quick view of one actor's snapshot, with a link to the full inspector. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ScanSearchIcon from '@lucide/svelte/icons/scan-search';
	import { inspectActor } from '$lib/remote/actors.remote';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import SnapshotView from './SnapshotView.svelte';
	import ActorGone from './ActorGone.svelte';
	import { actorHref } from './inspect';

	let { address }: { address: { family: string; name: string } } = $props();
	let open = $state(false);
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon" class="size-7" title="Quick view" aria-label="Quick view {address.family}/{address.name}">
				<ScanSearchIcon />
			</Button>
		{/snippet}
	</Dialog.Trigger>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title class="font-mono">{address.family}/{address.name}</Dialog.Title>
			<Dialog.Description>
				Snapshot of the actor's inside. <a class="underline underline-offset-4" href={actorHref(address)}>Open the full inspector</a> for live mode and diffs.
			</Dialog.Description>
		</Dialog.Header>
		{#if open}
			<svelte:boundary>
				{@const snap = await inspectActor({ address })}
				{#if snap}<SnapshotView {snap} compact />{:else}<ActorGone family={address.family} name={address.name} />{/if}
				{#snippet pending()}<Skeleton class="h-64 w-full" />{/snippet}
				{#snippet failed(error, reset)}<ErrorAlert {error} retry={reset} />{/snippet}
			</svelte:boundary>
		{/if}
	</Dialog.Content>
</Dialog.Root>
