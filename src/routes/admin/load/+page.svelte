<!-- Load tester (ADR 0076): scenarios, live metrics, invariants. -->
<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
	import { getLoadgenStatus, listPersonaKinds, listScenarios, resetLoadgen } from '$lib/remote/load.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { describeError } from '$lib/components/app/format';
	import ScenarioCreate from '$lib/components/dev/load/ScenarioCreate.svelte';
	import ScenarioView from '$lib/components/dev/load/ScenarioView.svelte';
	import { SCENARIO_TONE, duration, isTerminal, scenarioHref } from '$lib/components/dev/load/meta';

	const status = getLoadgenStatus();
	const scenarios = listScenarios();
	const kinds = listPersonaKinds();

	$effect(() => {
		const t = setInterval(() => {
			const list = scenarios.current;
			if (list?.some((s) => !isTerminal(s.state))) void scenarios.refresh();
		}, 2000);
		return () => clearInterval(t);
	});

	const requested = $derived(page.url.searchParams.get('scenario'));

	async function reset() {
		try {
			await resetLoadgen();
			toast.success('Load generator reset');
			await goto('/admin/load', { noScroll: true });
		} catch (e) {
			toast.error(describeError(e).message);
		}
	}
</script>

<PageHeader
	title="Load tester"
	description="Seeded populations of personas (statecharts) drive granary through the fake GitHub; an observer checks granary's promises."
>
	{#snippet actions()}
		<AlertDialog.Root>
			<AlertDialog.Trigger>
				{#snippet child({ props })}<Button {...props} variant="outline" size="sm"><RotateCcwIcon /> Reset</Button>{/snippet}
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>Reset the load generator?</AlertDialog.Title>
					<AlertDialog.Description>Stops a running scenario and forgets every scenario and persona. The fake GitHub and granary keep their data.</AlertDialog.Description>
				</AlertDialog.Header>
				<AlertDialog.Footer>
					<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
					<AlertDialog.Action onclick={reset}>Reset</AlertDialog.Action>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	{/snippet}
</PageHeader>

<svelte:boundary>
	{@const st = await status}
	{@const list = await scenarios}
	{@const catalogue = await kinds.catch(() => [])}
	{#if !st.reachable}
		<Alert.Root variant="destructive">
			<PlugZapIcon />
			<Alert.Title>Load generator not reachable</Alert.Title>
			<Alert.Description>
				{st.error} — start it with <code class="font-mono">mise run up</code> (or <code class="font-mono">mise run loadgen</code>).
			</Alert.Description>
		</Alert.Root>
	{:else}
		{@const selected = requested ?? st.status?.activeScenarioId ?? list[0]?.id ?? null}
		<div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]">
			<div class="bg-card overflow-hidden rounded-xl border">
				<Table.Root stack>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Scenario</Table.Head>
							<Table.Head>State</Table.Head>
							<Table.Head class="text-right">Personas</Table.Head>
							<Table.Head class="text-right">Issues</Table.Head>
							<Table.Head class="text-right">Violations</Table.Head>
							<Table.Head class="text-right">Active</Table.Head>
							<Table.Head>Created</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each list as s (s.id)}
							<Table.Row data-selected={s.id === selected} class={s.id === selected ? 'bg-muted/60' : ''}>
								<Table.Cell>
									<a href={scenarioHref(s.id)} class="font-medium underline-offset-4 hover:underline" data-sveltekit-noscroll>{s.name}</a>
									<span class="text-muted-foreground ml-1 font-mono text-xs">{s.id} · seed {s.seed}</span>
								</Table.Cell>
								<Table.Cell><StateBadge state={s.state} tone={SCENARIO_TONE[s.state]} /></Table.Cell>
								<Table.Cell class="text-right tabular-nums">{s.personasArrived}/{s.personasPlanned}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{s.issuesOpened}</Table.Cell>
								<Table.Cell class="text-right tabular-nums {s.violations ? 'font-semibold text-red-600 dark:text-red-400' : ''}">{s.violations}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{duration(s.elapsedMs)}</Table.Cell>
								<Table.Cell><RelativeTime ms={s.createdAt} class="text-muted-foreground text-xs" /></Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row><Table.Cell colspan={7} class="text-muted-foreground py-8 text-center">No scenarios yet — create one →</Table.Cell></Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				<p class="text-muted-foreground border-t px-4 py-2 text-xs">
					Event stream from the fake GitHub: {st.status?.eventStream.connected ? 'connected' : `disconnected (${st.status?.eventStream.error ?? '…'})`} ·
					allowlisted: <span class="font-mono">{st.status?.allowlisted.join(', ') || '—'}</span> ·
					headless: <code class="font-mono">mise run load:run -- --preset chaos --seed 7</code>
				</p>
			</div>
			<ScenarioCreate presets={st.status?.presets ?? []} kinds={catalogue} busy={list.some((s) => !isTerminal(s.state) && s.state !== 'created')} />
		</div>

		{#if selected}
			{#key selected}
				<ScenarioView id={selected} />
			{/key}
		{/if}
	{/if}
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void status.refresh(); void scenarios.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
