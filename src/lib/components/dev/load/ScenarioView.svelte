<!-- One scenario: controls, tiles, charts, invariants, violations, population, log (ADR 0076). -->
<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import SquareIcon from '@lucide/svelte/icons/square';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { controlScenario, getScenario } from '$lib/remote/load.remote';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { describeError } from '$lib/components/app/format';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import type { ScenarioAction } from '$lib/schemas/dev';
	import LineChart from './LineChart.svelte';
	import MetricTiles from './MetricTiles.svelte';
	import InvariantList from './InvariantList.svelte';
	import ViolationList from './ViolationList.svelte';
	import KindIcon from './KindIcon.svelte';
	import { KIND_LABEL, SCENARIO_TONE, duration, isTerminal } from './meta';

	let { id }: { id: string } = $props();

	const detail = $derived(getScenario({ id }));
	let live = $state(true);
	let acting = $state<ScenarioAction | null>(null);

	$effect(() => {
		const q = detail;
		const t = setInterval(() => {
			const cur = q.current;
			if (cur && isTerminal(cur.summary.state)) {
				live = false;
				return;
			}
			live = true;
			void q.refresh();
		}, 1500);
		return () => clearInterval(t);
	});

	async function act(action: ScenarioAction) {
		acting = action;
		try {
			await controlScenario({ id, action });
		} catch (e) {
			toast.error(describeError(e).message);
		} finally {
			acting = null;
		}
	}
</script>

<svelte:boundary>
	{@const d = await detail}
	{@const s = d.summary}
	{@const x = d.series.map((p) => p.t)}
	<section class="space-y-4" data-testid="scenario" data-state={s.state}>
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<h2 class="text-lg font-semibold">{s.name} <span class="text-muted-foreground font-mono text-sm font-normal">{s.id}</span></h2>
			<StateBadge state={s.state} tone={SCENARIO_TONE[s.state]} />
			{#if s.faultsActive}<StateBadge state="faults active" tone="warning" />{/if}
			<span class="text-muted-foreground text-sm">
				seed <span class="font-mono">{s.seed}</span> · {duration(s.elapsedMs)} active · personas {s.personasArrived}/{s.personasPlanned}
				({s.personasActive} active) · repo <span class="font-mono">{s.repo.owner}/{s.repo.name}</span>
			</span>
			<div class="ml-auto flex gap-2">
				{#if s.state === 'created'}
					<Button size="sm" disabled={acting !== null} onclick={() => act('start')}><PlayIcon /> Start</Button>
				{/if}
				{#if s.state === 'running'}
					<Button size="sm" variant="outline" disabled={acting !== null} onclick={() => act('pause')}><PauseIcon /> Pause</Button>
				{/if}
				{#if s.state === 'paused'}
					<Button size="sm" disabled={acting !== null} onclick={() => act('resume')}><PlayIcon /> Resume</Button>
				{/if}
				{#if !isTerminal(s.state)}
					<Button size="sm" variant="destructive" disabled={acting !== null} onclick={() => act('stop')}><SquareIcon /> Stop</Button>
				{/if}
				<Button size="sm" variant="outline" href="/__dev/load/personas?scenario={encodeURIComponent(s.id)}"><UsersIcon /> Personas</Button>
			</div>
		</div>

		<MetricTiles m={d.metrics} violations={s.violations} />

		<div class="grid gap-3 lg:grid-cols-3">
			<div class="lg:col-span-2">
				<LineChart
					title="Issues over time"
					subtitle="cumulative: opened by personas vs. closed by granary"
					{x}
					series={[
						{ key: 'opened', label: 'opened', values: d.series.map((p) => p.opened) },
						{ key: 'closed', label: 'closed', values: d.series.map((p) => p.closed) }
					]}
				/>
			</div>
			<LineChart
				title="Backlog"
				subtitle="issues that should be closed and are not yet"
				{x}
				series={[{ key: 'backlog', label: 'waiting', values: d.series.map((p) => p.backlog) }]}
			/>
			<LineChart
				title="Close latency p95"
				subtitle="open → granary closes it (cumulative p95)"
				{x}
				format={(v) => duration(v)}
				series={[{ key: 'p95', label: 'p95', values: d.series.map((p) => p.p95) }]}
			/>
			<LineChart
				title="Active personas"
				subtitle="arrived and not yet in a final state"
				{x}
				series={[{ key: 'active', label: 'active', values: d.series.map((p) => p.activePersonas) }]}
			/>
			<LineChart
				title="Webhook deliveries"
				subtitle="cumulative, to granary"
				{x}
				series={[{ key: 'deliveries', label: 'deliveries', values: d.series.map((p) => p.deliveries) }]}
			/>
		</div>

		<div class="grid gap-4 lg:grid-cols-2">
			<div class="space-y-2">
				<h3 class="text-sm font-medium">Invariants</h3>
				<InvariantList invariants={d.invariants} />
			</div>
			<div class="space-y-2">
				<h3 class="text-sm font-medium">Violations <span class="text-muted-foreground font-normal">(newest first, with evidence)</span></h3>
				<ViolationList violations={d.violations} />
			</div>
		</div>

		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>Population</Card.Title>
					<Card.Description>Who arrived, and which state they are in right now.</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if d.personaCounts.length === 0}
						<p class="text-muted-foreground text-sm">Nobody has arrived yet.</p>
					{:else}
						<table class="w-full text-sm">
							<thead class="text-muted-foreground text-left text-xs">
								<tr><th class="pb-1 font-medium">Kind</th><th class="pb-1 text-right font-medium">Arrived</th><th class="pb-1 text-right font-medium">Active</th><th class="pb-1 pl-4 font-medium">States</th></tr>
							</thead>
							<tbody>
								{#each d.personaCounts as c (c.kind)}
									<tr class="border-t">
										<td class="py-1.5">
											<a href="/__dev/load/personas?scenario={encodeURIComponent(s.id)}&kind={c.kind}" class="inline-flex items-center gap-1.5 underline-offset-4 hover:underline">
												<KindIcon kind={c.kind} class="text-muted-foreground size-4" />{KIND_LABEL[c.kind]}
											</a>
										</td>
										<td class="py-1.5 text-right tabular-nums">{c.arrived}</td>
										<td class="py-1.5 text-right tabular-nums">{c.active}</td>
										<td class="py-1.5 pl-4">
											<div class="flex flex-wrap gap-1">
												{#each Object.entries(c.states) as [st, n] (st)}
													<span class="bg-muted rounded px-1.5 font-mono text-xs leading-5">{st} <span class="text-muted-foreground">×{n}</span></span>
												{/each}
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Title>Coordinator log</Card.Title>
					<Card.Description>What the <span class="font-mono">scenario/{s.id}</span> statechart reported.</Card.Description>
				</Card.Header>
				<Card.Content>
					<ol class="max-h-64 space-y-1 overflow-auto text-sm">
						{#each d.log as entry, i (i)}
							<li class="grid grid-cols-[7.5rem_1fr] gap-2"><RelativeTime ms={entry.at} class="text-muted-foreground pt-0.5 text-xs" /><span>{entry.text}</span></li>
						{/each}
					</ol>
					<details class="mt-3">
						<summary class="text-muted-foreground cursor-pointer text-xs">Configuration</summary>
						<div class="mt-2"><JsonBlock value={d.config} preset="compact" rootLabel="config" alwaysTree /></div>
					</details>
				</Card.Content>
			</Card.Root>
		</div>
		{#if live && !isTerminal(s.state)}<p class="text-muted-foreground text-xs">Refreshing every 1.5 s.</p>{/if}
	</section>
	{#snippet pending()}
		<div class="bg-muted/40 h-64 animate-pulse rounded-lg"></div>
	{/snippet}
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void detail.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
