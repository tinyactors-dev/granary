<!-- Dev portal overview (ADR 0076): is everything up, and where to go next. -->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import { getDevInfo } from '$lib/remote/dev.remote';
	import { getLoadgenStatus, listScenarios } from '$lib/remote/load.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import { shellData } from '$lib/components/app/session';
	import { DEV_NAV } from '$lib/components/dev/nav';
	import DevTools from '$lib/components/dev/DevTools.svelte';
	import { SCENARIO_TONE, duration, scenarioHref } from '$lib/components/dev/load/meta';

	const info = getDevInfo();
	const loadgen = getLoadgenStatus();
	const scenarios = listScenarios();
	const user = $derived(shellData().user);

	$effect(() => {
		const t = setInterval(() => {
			void loadgen.refresh();
			void scenarios.refresh();
		}, 3000);
		return () => clearInterval(t);
	});
</script>

<PageHeader title="Developer console" description="Only in dev mode. Everything you need to poke granary: sessions, the fake GitHub, load and personas, traces, actors." />

<svelte:boundary>
	{@const dev = await info}
	{@const lg = await loadgen}
	{@const list = await scenarios.catch(() => [])}
	{@const fake = dev.fakeGithub}
	{@const active = list.find((s) => s.id === lg.status?.activeScenarioId) ?? list[0] ?? null}
	<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="dev-status">
		{#snippet ok(up: boolean, label: string)}
			<span class="inline-flex items-center gap-1 text-xs font-medium {up ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}">
				{#if up}<CircleCheckIcon class="size-4" />{:else}<CircleXIcon class="size-4" />{/if}{label}
			</span>
		{/snippet}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center justify-between">granary {@render ok(true, 'up')}</Card.Title>
				<Card.Description>dev mode on · {user ? `signed in as ${user.login}${user.isAdmin ? ' (admin)' : ''}` : 'not signed in'}</Card.Description>
			</Card.Header>
			<Card.Content class="text-sm"><a class="underline-offset-4 hover:underline" href="/__dev/sessions">{user ? 'switch user' : 'log in as…'} →</a></Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center justify-between">Fake GitHub {@render ok(fake.reachable, fake.reachable ? 'up' : 'down')}</Card.Title>
				<Card.Description class="truncate font-mono text-xs">{dev.fakeGithubUrl}</Card.Description>
			</Card.Header>
			<Card.Content class="text-sm">
				{#if fake.state}
					{fake.state.users.length} users · {fake.state.repos.length} repos · {fake.state.issues.length} issues · {fake.state.deliveries.length} deliveries{fake.state.faults.length ? ` · ${fake.state.faults.length} faults armed` : ''}
				{:else}
					<span class="text-muted-foreground">{fake.error}</span>
				{/if}
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center justify-between">Load generator {@render ok(lg.reachable, lg.reachable ? 'up' : 'down')}</Card.Title>
				<Card.Description class="truncate font-mono text-xs">{lg.url}</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-1 text-sm">
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
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title>Debugger</Card.Title>
				<Card.Description>DAP on <span class="font-mono">{dev.dapHost}:{dev.dapPort}</span></Card.Description>
			</Card.Header>
			<Card.Content class="text-sm"><a class="underline-offset-4 hover:underline" href="/__dev/actors">attach configurations →</a></Card.Content>
		</Card.Root>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Tools</Card.Title>
			<Card.Description>Everything worth opening, with links taken from config and /ops settings — the same links work in production.</Card.Description>
		</Card.Header>
		<Card.Content><DevTools /></Card.Content>
	</Card.Root>

	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		{#each DEV_NAV.filter((i) => i.href !== '/__dev') as item (item.href)}
			<a href={item.href} class="bg-card hover:border-primary/40 flex items-start gap-3 rounded-lg border p-4 transition-colors">
				<item.icon class="text-muted-foreground mt-0.5 size-5 shrink-0" />
				<div>
					<div class="font-medium">{item.label}</div>
					<div class="text-muted-foreground text-sm">{item.description}</div>
				</div>
			</a>
		{/each}
	</div>
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void info.refresh(); void loadgen.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
