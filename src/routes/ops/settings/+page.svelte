<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import BudgetsForm from '$lib/components/ops/BudgetsForm.svelte';
	import ConfigTransfer from '$lib/components/ops/ConfigTransfer.svelte';
	import { getOpsBudgets } from '$lib/remote/ops.remote';

	const budgets = getOpsBudgets();
</script>

<PageHeader title="Budgets & config" description="Limits that keep ops from filling the disk or the bill, and the whole configuration as a file." />

<Card.Root>
	<Card.Header>
		<Card.Title>Budgets</Card.Title>
		<Card.Description>Disk thresholds are relative to the disk size the host reports, so they keep working when the disk grows.</Card.Description>
	</Card.Header>
	<Card.Content>
		<svelte:boundary>
			{@const b = await budgets}
			{#key b.version}<BudgetsForm budgets={b} />{/key}
			{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
		</svelte:boundary>
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>Export / import</Card.Title>
	</Card.Header>
	<Card.Content><ConfigTransfer /></Card.Content>
</Card.Root>
