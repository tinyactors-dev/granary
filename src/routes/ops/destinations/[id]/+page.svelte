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
	import ExternalLink from '$lib/components/ops/ExternalLink.svelte';
	import { destinationConsoleLink } from '$lib/ops/contract';
	import { describeError } from '$lib/components/app/format';
	import DestinationForm from '$lib/components/ops/DestinationForm.svelte';
	import ProjectionMeters from '$lib/components/ops/ProjectionMeters.svelte';
	import RetentionPreviewCard from '$lib/components/ops/RetentionPreviewCard.svelte';
	import {
		deleteOpsDestination,
		getOpsProjections,
		getOpsRetentionPreview,
		listOpsDestinations,
		listOpsSecrets
	} from '$lib/remote/ops.remote';

	const id = $derived(page.params.id ?? '');
	const destinations = listOpsDestinations();
	const secrets = listOpsSecrets();
	let confirming = $state(false);

	async function remove() {
		try {
			await deleteOpsDestination({ id });
			toast.success('Destination deleted', { description: 'Objects already in the bucket were not touched.' });
			await goto('/ops/destinations');
		} catch (e) {
			toast.error('Could not delete', { description: describeError(e).message });
		} finally {
			confirming = false;
		}
	}
</script>

<svelte:boundary>
	{@const d = (await destinations).find((x) => x.id === id)}
	{#if !d}
		<PageHeader title="Unknown destination" description={id} />
		<a class="text-sm underline" href="/ops/destinations">Back to destinations</a>
	{:else}
		<PageHeader title={d.name} description="Version {d.version} · {d.origin === 'seed' ? 'set up from the environment at startup — editing makes it yours' : 'configured here'}">
			{#snippet actions()}
				{@const link = destinationConsoleLink(d)}
				{#if link}<Button variant="outline" href={link.url} target="_blank" rel="noreferrer" data-testid="external-link">{link.label} ↗</Button>{/if}
				<AdminOnly reason="Only admins can delete destinations">
					{#snippet children({ disabled })}
						<Button variant="outline" {disabled} onclick={() => (confirming = true)}><TrashIcon /> Delete</Button>
					{/snippet}
				</AdminOnly>
			{/snippet}
		</PageHeader>

		{#key d.version}
			<DestinationForm destination={d} secrets={await secrets} />
		{/key}

		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>Projections</Card.Title>
					<Card.Description>Steady-state storage against the caps, and billed egress against the budget.</Card.Description>
				</Card.Header>
				<Card.Content>
					<svelte:boundary>
						<ProjectionMeters projections={await getOpsProjections({ id })} />
						{#snippet pending()}<Skeleton class="h-24 w-full" />{/snippet}
						{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
					</svelte:boundary>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Title>Retention dry-run</Card.Title>
					<Card.Description>Exactly what the next retention pass would do with the saved settings.</Card.Description>
				</Card.Header>
				<Card.Content>
					<svelte:boundary>
						<RetentionPreviewCard preview={await getOpsRetentionPreview({ id })} />
						{#snippet pending()}<Skeleton class="h-24 w-full" />{/snippet}
						{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
					</svelte:boundary>
				</Card.Content>
			</Card.Root>
		</div>

		<AlertDialog.Root bind:open={confirming}>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>Delete "{d.name}"?</AlertDialog.Title>
					<AlertDialog.Description>
						granary stops uploading here. Backups already stored stay in the bucket; nothing is deleted remotely. Plans that use it must be changed first.
					</AlertDialog.Description>
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
