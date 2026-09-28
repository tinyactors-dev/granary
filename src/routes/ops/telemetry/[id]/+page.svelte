<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { toast } from 'svelte-sonner';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import SinkForm from '$lib/components/ops/SinkForm.svelte';
	import SinkStats from '$lib/components/ops/SinkStats.svelte';
	import { deleteOpsSink, getOpsSinkStats, getOpsStatus, listOpsSecrets, listOpsSinks } from '$lib/remote/ops.remote';

	const id = $derived(page.params.id ?? '');
	const sinks = listOpsSinks();
	const secrets = listOpsSecrets();
	const status = getOpsStatus();
	let confirming = $state(false);

	async function remove() {
		try {
			await deleteOpsSink({ id });
			toast.success('Sink deleted');
			await goto('/ops/telemetry');
		} catch (e) {
			toast.error('Could not delete', { description: describeError(e).message });
		} finally {
			confirming = false;
		}
	}
</script>

<svelte:boundary>
	{@const sink = (await sinks).find((x) => x.id === id)}
	{#if !sink}
		<PageHeader title="Unknown sink" description={id} />
	{:else}
		<PageHeader title={sink.name} description="Version {sink.version} · {sink.origin === 'seed' ? 'set up from the environment at startup' : 'configured here'}">
			{#snippet actions()}
				<AdminOnly reason="Only admins can delete sinks">
					{#snippet children({ disabled })}<Button variant="outline" {disabled} onclick={() => (confirming = true)}><TrashIcon /> Delete</Button>{/snippet}
				</AdminOnly>
			{/snippet}
		</PageHeader>
		<Card.Root>
			<Card.Header><Card.Title>Last 24 hours</Card.Title></Card.Header>
			<Card.Content>
				<svelte:boundary>
					<SinkStats stats={await getOpsSinkStats({ id })} state={(await status).telemetry.find((t) => t.sinkId === id)} />
					{#snippet pending()}<Skeleton class="h-28 w-full" />{/snippet}
					{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
				</svelte:boundary>
			</Card.Content>
		</Card.Root>
		{#key sink.version}<SinkForm {sink} secrets={await secrets} />{/key}
		<AlertDialog.Root bind:open={confirming}>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>Delete "{sink.name}"?</AlertDialog.Title>
					<AlertDialog.Description>Telemetry stops going there. Whatever is buffered for it is dropped.</AlertDialog.Description>
				</AlertDialog.Header>
				<AlertDialog.Footer>
					<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
					<AlertDialog.Action class={buttonVariants({ variant: 'destructive' })} onclick={remove}>Delete</AlertDialog.Action>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	{/if}
	{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
</svelte:boundary>
