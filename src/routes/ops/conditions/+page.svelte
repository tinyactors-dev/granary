<script lang="ts">
	import type { Condition, OpsEvent, OpsEventKind } from '$lib/ops/contract';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import FilterTabs from '$lib/components/app/FilterTabs.svelte';
	import ConditionCard from '$lib/components/ops/ConditionCard.svelte';
	import EventTimeline from '$lib/components/ops/EventTimeline.svelte';
	import { page } from '$app/state';
	import { listOpsConditions, listOpsEvents } from '$lib/remote/ops.remote';

	const conditions = listOpsConditions();
	const ORDER: Condition['state'][] = ['attention', 'healing', 'suspect', 'acknowledged', 'ok'];
	const sorted = (list: Condition[]) => [...list].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));

	const KINDS: OpsEventKind[] = ['handled', 'attention', 'ack', 'info'];
	const kind = $derived((KINDS as string[]).includes(page.url.searchParams.get('kind') ?? '') ? (page.url.searchParams.get('kind') as OpsEventKind) : '');
	let older = $state<OpsEvent[]>([]);
	let cursor = $state<string | null>(null);
	let loadingMore = $state(false);
	const events = $derived(listOpsEvents(kind ? { kind, limit: 30 } : { limit: 30 }));

	$effect(() => {
		void kind;
		older = [];
		cursor = null;
	});

	async function more(next: string) {
		loadingMore = true;
		try {
			const pg = await listOpsEvents(kind ? { kind, limit: 30, before: next } : { limit: 30, before: next });
			older = [...older, ...pg.items];
			cursor = pg.nextCursor;
		} finally {
			loadingMore = false;
		}
	}
</script>

<PageHeader
	title="Conditions"
	description="What the watchdog keeps an eye on. Each tries to fix itself first; only what it can't fix waits for you — never urgently."
/>

<div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
	<svelte:boundary>
		<div class="grid gap-3" data-testid="ops-conditions">
			{#each sorted(await conditions) as c (c.id)}
				<ConditionCard condition={c} />
			{:else}
				<p class="text-muted-foreground text-sm">No conditions are tracked yet.</p>
			{/each}
		</div>
		{#snippet failed(error, reset)}
			<ErrorAlert {error} retry={() => { void conditions.refresh(); reset(); }} />
		{/snippet}
	</svelte:boundary>

	<Card.Root>
		<Card.Header>
			<Card.Title>History</Card.Title>
			<Card.Description>Handled, needs-you and acknowledged events.</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-4">
			<FilterTabs param="kind" values={KINDS} current={kind || null} />
			<svelte:boundary>
				{@const first = await events}
				<EventTimeline events={[...first.items, ...older]} />
				{@const next = older.length ? cursor : first.nextCursor}
				{#if next}
					<Button variant="outline" size="sm" disabled={loadingMore} onclick={() => more(next)}>Load older</Button>
				{/if}
				{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
			</svelte:boundary>
		</Card.Content>
	</Card.Root>
</div>
