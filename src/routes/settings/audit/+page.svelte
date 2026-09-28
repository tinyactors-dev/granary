<!-- /settings/audit (ADR 0161, 0210): who changed what. Admins only; never contains secrets. -->
<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import TableSkeleton from '$lib/components/app/TableSkeleton.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import { isAdmin } from '$lib/components/app/session';
	import { AUDIT_LABELS } from '$lib/components/settings/nav';
	import { listAuditLog } from '$lib/remote/settings.remote';

	const admin = $derived(isAdmin());
</script>

<PageHeader title="Audit log" description="Who changed admins, sign-in links, the GitHub connection, the policy or settings. Newest first." />

{#if !admin}
	<p class="text-muted-foreground text-sm">Only admins can see the audit log.</p>
{:else}
	{@const log = listAuditLog({ limit: 200 })}
	<div class="bg-card overflow-hidden rounded-xl border">
		<svelte:boundary>
			{@const list = await log}
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>When</Table.Head>
						<Table.Head>Who</Table.Head>
						<Table.Head>What</Table.Head>
						<Table.Head>Subject</Table.Head>
						<Table.Head>Detail</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each list as e (e.id)}
						<Table.Row data-testid="audit-row">
							<Table.Cell class="text-muted-foreground whitespace-nowrap"><RelativeTime ms={e.at} /></Table.Cell>
							<Table.Cell class="font-medium">{e.actor}</Table.Cell>
							<Table.Cell>{AUDIT_LABELS[e.action] ?? e.action}</Table.Cell>
							<Table.Cell class="break-all">{e.subject}</Table.Cell>
							<Table.Cell class="max-w-72">{#if e.detail !== null && e.detail !== undefined}<JsonBlock value={e.detail} preset="inline" rootLabel="detail" />{:else}<span class="text-muted-foreground">—</span>{/if}</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row class="hover:bg-transparent"><Table.Cell colspan={5} class="text-muted-foreground py-10 text-center">Nothing recorded yet.</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#snippet pending()}<TableSkeleton columns={5} rows={4} />{/snippet}
			{#snippet failed(error, reset)}
				<div class="p-4"><ErrorAlert {error} retry={() => { void log.refresh(); reset(); }} /></div>
			{/snippet}
		</svelte:boundary>
	</div>
{/if}
