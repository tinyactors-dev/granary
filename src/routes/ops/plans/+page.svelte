<script lang="ts">
	import type { BackupPlan } from '$lib/ops/contract';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { toast } from 'svelte-sonner';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';
	import PlanDialog from '$lib/components/ops/PlanDialog.svelte';
	import RunNowButton from '$lib/components/ops/RunNowButton.svelte';
	import { duration } from '$lib/components/ops/format';
	import { deleteOpsPlan, getOpsStatus, listOpsDestinations, listOpsPlans } from '$lib/remote/ops.remote';

	const plans = listOpsPlans();
	const destinations = listOpsDestinations();
	const status = getOpsStatus();

	let editing = $state<BackupPlan | null>(null);
	let dialogOpen = $state(false);
	let deleting = $state<BackupPlan | null>(null);

	function edit(p: BackupPlan | null) {
		editing = p;
		dialogOpen = true;
	}

	async function remove() {
		if (!deleting) return;
		const p = deleting;
		try {
			await deleteOpsPlan({ id: p.id });
			toast.success(`Deleted "${p.name}"`, { description: 'Existing backups are kept until retention prunes them.' });
		} catch (e) {
			toast.error('Could not delete', { description: describeError(e).message });
		} finally {
			deleting = null;
		}
	}
</script>

<PageHeader title="Plans" description="Schedules: which databases are backed up, where to, and how often restore drills run.">
	{#snippet actions()}
		{#if isAdmin()}<Button onclick={() => edit(null)}><PlusIcon /> New plan</Button>{/if}
	{/snippet}
</PageHeader>

<svelte:boundary>
	{@const planList = await plans}
	{@const dests = await destinations}
	{@const s = await status}
	{@const databases = [...new Set([...s.backups.map((b) => b.database), ...planList.flatMap((p) => p.databases), 'granary', 'ops'])]}
	<div class="bg-card overflow-hidden rounded-xl border">
		<Table.Root>
			<Table.Header>
				<Table.Row class="hover:bg-transparent">
					<Table.Head>Plan</Table.Head>
					<Table.Head>Databases</Table.Head>
					<Table.Head>Destinations</Table.Head>
					<Table.Head>Interval</Table.Head>
					<Table.Head>Drill</Table.Head>
					<Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each planList as p (p.id)}
					<Table.Row data-testid="ops-plan">
						<Table.Cell>
							<div class="flex items-center gap-2 font-medium">{p.name} <StateBadge state={p.enabled ? 'enabled' : 'paused'} tone={p.enabled ? 'success' : 'muted'} /></div>
							<span class="text-muted-foreground font-mono text-xs">{p.id}</span>
						</Table.Cell>
						<Table.Cell>{p.databases.join(', ')}</Table.Cell>
						<Table.Cell>{p.destinationIds.map((id) => dests.find((d) => d.id === id)?.name ?? id).join(', ')}</Table.Cell>
						<Table.Cell>
							{duration(p.effectiveIntervalMs)}
							{#if p.effectiveIntervalMs !== p.intervalMs}<span class="text-muted-foreground block text-xs">configured {duration(p.intervalMs)}; stretched for the egress budget</span>{/if}
						</Table.Cell>
						<Table.Cell>every {duration(p.drillIntervalMs)}</Table.Cell>
						<Table.Cell>
							<div class="flex justify-end gap-1">
								<RunNowButton planId={p.id} />
								<AdminOnly reason="Only admins can edit plans">
									{#snippet children({ disabled })}
										<Button variant="ghost" size="icon-sm" {disabled} aria-label="Edit {p.name}" onclick={() => edit(p)}><PencilIcon /></Button>
										<Button variant="ghost" size="icon-sm" {disabled} aria-label="Delete {p.name}" onclick={() => (deleting = p)}><TrashIcon /></Button>
									{/snippet}
								</AdminOnly>
							</div>
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row class="hover:bg-transparent"><Table.Cell colspan={6} class="text-muted-foreground py-10 text-center">No plans yet.</Table.Cell></Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
	<PlanDialog bind:open={dialogOpen} plan={editing} destinations={dests} {databases} />
	{#snippet failed(error, reset)}<ErrorAlert {error} retry={() => { void plans.refresh(); reset(); }} />{/snippet}
</svelte:boundary>

<AlertDialog.Root open={deleting !== null} onOpenChange={(o) => { if (!o) deleting = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete "{deleting?.name}"?</AlertDialog.Title>
			<AlertDialog.Description>No new backups run for it. Existing backups stay until retention prunes them.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action class={buttonVariants({ variant: 'destructive' })} onclick={remove}>Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
