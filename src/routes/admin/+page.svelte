<!--
	Admin overview (ADR 0290): the actor system's runtime numbers, which areas
	are available here, the simulation services and the external tools.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import CircleMinusIcon from '@lucide/svelte/icons/circle-minus';
	import { getOverview } from '$lib/remote/dashboard.remote';
	import { getDevInfo } from '$lib/remote/dev.remote';
	import { getLoadgenStatus, listScenarios } from '$lib/remote/load.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import { formatBytes } from '$lib/components/app/format';
	import { shellData } from '$lib/components/app/session';
	import { ADMIN_NAV, adminAvailable } from '$lib/components/admin/nav';
	import DevTools from '$lib/components/dev/DevTools.svelte';
	import { SCENARIO_TONE, duration, scenarioHref } from '$lib/components/dev/load/meta';

	const shell = $derived(shellData());
	const caps = $derived(shell.admin);
	const overview = $derived(shell.user ? getOverview() : null);
	const info = getDevInfo();
	const loadgen = $derived(caps.loadgen ? getLoadgenStatus() : null);
	const scenarios = $derived(caps.loadgen ? listScenarios() : null);

	$effect(() => {
		if (!loadgen) return;
		const t = setInterval(() => {
			void loadgen.refresh();
			void scenarios?.refresh();
		}, 3000);
		return () => clearInterval(t);
	});
</script>

<PageHeader title="Admin" description="What's inside granary: the actor system, traces and the debugger, plus the simulation services used to exercise it." />

{#snippet status(state: 'up' | 'down' | 'off', label: string)}
	<span class="inline-flex items-center gap-1 text-xs font-medium {state === 'up' ? 'text-emerald-700 dark:text-emerald-400' : state === 'down' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground'}">
		{#if state === 'up'}<CircleCheckIcon class="size-4" />{:else if state === 'down'}<CircleXIcon class="size-4" />{:else}<CircleMinusIcon class="size-4" />{/if}{label}
	</span>
{/snippet}

<div class="grid gap-3 lg:grid-cols-2" data-testid="admin-status">
	<Card.Root data-testid="admin-runtime">
		<Card.Header>
			<Card.Title>Actor system</Card.Title>
			<Card.Description>granary's runtime. <a class="text-foreground underline-offset-4 hover:underline" href="/admin/actors">Actors →</a></Card.Description>
		</Card.Header>
		<Card.Content>
			{#if overview}
				<svelte:boundary>
					{@const o = await overview}
					<dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
						<dt class="text-muted-foreground">Resident actors</dt>
						<dd class="text-right tabular-nums">{o.system.residentActors}</dd>
						<dt class="text-muted-foreground">Queued messages</dt>
						<dd class="text-right tabular-nums">{o.system.queuedMessages}</dd>
						<dt class="text-muted-foreground">Delivered messages</dt>
						<dd class="text-right tabular-nums">{o.system.deliveredMessages}</dd>
						<dt class="text-muted-foreground">Dead letters</dt>
						<dd class="text-right tabular-nums">{o.system.deadLetters}</dd>
						<dt class="text-muted-foreground">Memory</dt>
						<dd class="text-right tabular-nums">{formatBytes(o.system.memoryBytes)}</dd>
						<dt class="text-muted-foreground">Up since</dt>
						<dd class="text-right"><RelativeTime ms={o.system.startedAt} /></dd>
					</dl>
					<div class="mt-3 flex flex-wrap gap-1.5">
						{#each Object.entries(o.system.actorsByFamily) as [family, n] (family)}
							<span class="bg-muted rounded-md px-2 py-0.5 font-mono text-xs">{family} × {n}</span>
						{/each}
					</div>
					{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
				</svelte:boundary>
			{:else}
				<p class="text-muted-foreground text-sm">Sign in to see runtime numbers.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root data-testid="admin-capabilities">
		<Card.Header>
			<Card.Title>Available here</Card.Title>
			<Card.Description>{caps.devMode ? 'Development mode: everything is on.' : 'Production: simulation and debugging are off unless configured.'}</Card.Description>
		</Card.Header>
		<Card.Content>
			<ul class="space-y-1.5 text-sm">
				{#each ADMIN_NAV.filter((i) => i.capability) as item (item.href)}
					{@const on = adminAvailable(item, caps)}
					<li class="flex items-center justify-between gap-3">
						<a href={item.href} class="underline-offset-4 hover:underline">{item.label}</a>
						{@render status(on ? 'up' : 'off', on ? 'on' : 'off')}
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
</div>

<svelte:boundary>
	{@const dev = await info}
	<div class="grid gap-3 lg:grid-cols-2">
		<Card.Root data-testid="admin-fake-github">
			<Card.Header>
				<Card.Title class="flex items-center justify-between">
					Fake GitHub
					{#if caps.fakeGithub}{@render status(dev.fakeGithub.reachable ? 'up' : 'down', dev.fakeGithub.reachable ? 'up' : 'down')}{:else}{@render status('off', 'not configured')}{/if}
				</Card.Title>
				<Card.Description class="truncate font-mono text-xs">{caps.fakeGithub ? dev.fakeGithubUrl : 'FAKE_GITHUB_URL is not set'}</Card.Description>
			</Card.Header>
			<Card.Content class="text-sm">
				{#if !caps.fakeGithub}
					<span class="text-muted-foreground">Run the fake GitHub next to granary and set <code>FAKE_GITHUB_URL</code> to use it here. See the manual's operations runbook.</span>
				{:else if dev.fakeGithub.state}
					{dev.fakeGithub.state.users.length} users · {dev.fakeGithub.state.repos.length} repos · {dev.fakeGithub.state.issues.length} issues · {dev.fakeGithub.state.deliveries.length} deliveries{dev.fakeGithub.state.faults.length ? ` · ${dev.fakeGithub.state.faults.length} faults armed` : ''}
				{:else}
					<span class="text-muted-foreground">{dev.fakeGithub.error}</span>
				{/if}
			</Card.Content>
		</Card.Root>
		<Card.Root data-testid="admin-loadgen">
			<Card.Header>
				{#if loadgen}
					{@const lg = await loadgen}
					<Card.Title class="flex items-center justify-between">Load generator {@render status(lg.reachable ? 'up' : 'down', lg.reachable ? 'up' : 'down')}</Card.Title>
					<Card.Description class="truncate font-mono text-xs">{lg.url}</Card.Description>
				{:else}
					<Card.Title class="flex items-center justify-between">Load generator {@render status('off', 'not configured')}</Card.Title>
					<Card.Description class="font-mono text-xs">LOADGEN_URL is not set</Card.Description>
				{/if}
			</Card.Header>
			<Card.Content class="space-y-1 text-sm">
				{#if loadgen && scenarios}
					{@const lg = await loadgen}
					{@const list = await scenarios.catch(() => [])}
					{@const active = list.find((s) => s.id === lg.status?.activeScenarioId) ?? list[0] ?? null}
					{#if lg.status}
						<div>event stream {lg.status.eventStream.connected ? 'connected' : 'disconnected'} · {lg.status.scenarios} scenario(s)</div>
						{#if active}
							<a href={scenarioHref(active.id)} class="flex flex-wrap items-center gap-2 underline-offset-4 hover:underline">
								{active.name} <StateBadge state={active.state} tone={SCENARIO_TONE[active.state]} />
								<span class="text-muted-foreground text-xs">{active.issuesOpened} issues · {active.violations} violations · {duration(active.elapsedMs)}</span>
							</a>
						{/if}
					{:else}
						<span class="text-muted-foreground">{lg.error}</span>
					{/if}
				{:else}
					<span class="text-muted-foreground">The load generator drives the fake GitHub; configure both to run scenarios here.</span>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Tools</Card.Title>
			<Card.Description>Grafana, storage consoles and the simulation services, with links taken from configuration.</Card.Description>
		</Card.Header>
		<Card.Content><DevTools /></Card.Content>
	</Card.Root>
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void info.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
