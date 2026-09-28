<!-- Personas (ADR 0076): the population of a scenario, grouped by kind, plus the catalogue. -->
<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { getLoadgenStatus, listPersonaKinds, listScenarios } from '$lib/remote/load.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ChartTree from '$lib/components/actors/ChartTree.svelte';
	import NativeSelect from '$lib/components/dev/NativeSelect.svelte';
	import PersonaPopulation from '$lib/components/dev/load/PersonaPopulation.svelte';
	import KindIcon from '$lib/components/dev/load/KindIcon.svelte';
	import { KIND_LABEL, SCENARIO_TONE, isTerminal, scenarioHref } from '$lib/components/dev/load/meta';
	import { PERSONA_KINDS, type PersonaKind } from '$lib/schemas/dev';

	const status = getLoadgenStatus();
	const scenarios = listScenarios();
	const kinds = listPersonaKinds();

	$effect(() => {
		const t = setInterval(() => {
			if (scenarios.current?.some((x) => !isTerminal(x.state))) void scenarios.refresh();
		}, 2000);
		return () => clearInterval(t);
	});

	const kindFilter = $derived((page.url.searchParams.get('kind') as PersonaKind | null) ?? null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'population');

	function setParam(key: string, value: string | null) {
		const u = new URL(page.url);
		if (value) u.searchParams.set(key, value);
		else u.searchParams.delete(key);
		void goto(u, { noScroll: true, keepFocus: true, replaceState: true });
	}

	const EXPECT_TONE = { open: 'success', closed: 'danger', varies: 'info', none: 'muted' } as const;
	const EXPECT_TEXT = { open: 'should stay open', closed: 'should be closed', varies: 'per case', none: 'opens no issues' } as const;
</script>

<PageHeader title="Personas" description="Simulated people, each a statechart. Pick one to see its chart, its thoughts and what granary did to its issues." />

<Tabs.Root bind:value={tab} class="space-y-4">
	<Tabs.List>
		<Tabs.Trigger value="population">Population</Tabs.Trigger>
		<Tabs.Trigger value="catalogue">Catalogue</Tabs.Trigger>
	</Tabs.List>

	<Tabs.Content value="population">
		<svelte:boundary>
			{@const st = await status}
			{@const list = await scenarios}
			{@const scenarioId = page.url.searchParams.get('scenario') ?? st.status?.activeScenarioId ?? list[0]?.id ?? null}
			{@const scenario = list.find((s) => s.id === scenarioId) ?? null}
			<div class="mb-4 flex flex-wrap items-end gap-4">
				<div class="space-y-1.5">
					<Label for="p-scenario">Scenario</Label>
					<NativeSelect id="p-scenario" value={scenarioId ?? ''} onchange={(e) => setParam('scenario', (e.currentTarget as HTMLSelectElement).value || null)}>
						{#each list as s (s.id)}<option value={s.id}>{s.name} · {s.id} · {s.state}</option>{/each}
					</NativeSelect>
				</div>
				<div class="flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
					<button type="button" class="rounded-full border px-2.5 py-1 text-xs {kindFilter === null ? 'bg-muted font-medium' : 'text-muted-foreground'}" onclick={() => setParam('kind', null)}>all</button>
					{#each PERSONA_KINDS as k (k)}
						<button
							type="button"
							class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs {kindFilter === k ? 'bg-muted font-medium' : 'text-muted-foreground'}"
							onclick={() => setParam('kind', kindFilter === k ? null : k)}
						><KindIcon kind={k} class="size-3" />{KIND_LABEL[k]}</button>
					{/each}
				</div>
				{#if scenario}
					<div class="ml-auto flex items-center gap-2 text-sm">
						<StateBadge state={scenario.state} tone={SCENARIO_TONE[scenario.state]} />
						<a class="underline-offset-4 hover:underline" href={scenarioHref(scenario.id)}>scenario metrics →</a>
					</div>
				{/if}
			</div>
			{#if !scenarioId}
				<p class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
					No scenarios yet. <a class="underline" href="/admin/load">Start one</a>, or browse the catalogue.
				</p>
			{:else}
				{#key scenarioId}
					<PersonaPopulation scenarioId={scenarioId} kind={kindFilter} live={scenario !== null && !isTerminal(scenario.state)} />
				{/key}
			{/if}
			{#snippet failed(error, reset)}<ErrorAlert {error} retry={() => { void status.refresh(); void scenarios.refresh(); reset(); }} />{/snippet}
		</svelte:boundary>
	</Tabs.Content>

	<Tabs.Content value="catalogue">
		<svelte:boundary>
			{@const catalogue = await kinds}
			<div class="grid gap-4 lg:grid-cols-2">
				{#each catalogue as k (k.kind)}
					<details class="bg-card rounded-lg border p-4" data-testid="persona-kind">
						<summary class="cursor-pointer list-none">
							<div class="flex items-center gap-2">
								<KindIcon kind={k.kind} class="size-5" />
								<span class="font-medium">{k.title}</span>
								<span class="ml-auto"><StateBadge state={EXPECT_TEXT[k.expected]} tone={EXPECT_TONE[k.expected]} /></span>
							</div>
							<p class="text-muted-foreground mt-1 text-sm">{k.description}</p>
							<p class="text-muted-foreground mt-1 text-xs">▸ statechart ({k.chart?.states.length ?? 0} states) · <span class="font-mono">{k.chart?.sourceFile}</span></p>
						</summary>
						{#if k.chart}<div class="mt-3"><ChartTree chart={k.chart} active={[]} /></div>{/if}
					</details>
				{/each}
			</div>
			{#snippet failed(error, reset)}<ErrorAlert {error} retry={() => { void kinds.refresh(); reset(); }} />{/snippet}
		</svelte:boundary>
	</Tabs.Content>
</Tabs.Root>
