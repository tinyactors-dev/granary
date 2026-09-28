<!--
	/settings — General (ADR 0157, 0161, 0210): where granary thinks it lives,
	the setup state, the master key, and where each kind of setting comes from.
	Read-only: process-level settings are env/flags by design.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import CheckCircleIcon from '@lucide/svelte/icons/circle-check';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { getGitHubStatus, getSetupStatus, listAdmins } from '$lib/remote/settings.remote';

	const setup = getSetupStatus();
	const github = getGitHubStatus();
	const admins = listAdmins();

	const MODE_LABEL = { none: 'Not connected', app: 'GitHub App', token: 'Token (seeded)' } as const;
</script>

<PageHeader title="Settings" description="Where granary lives, how it is connected, and who may change things." />

<div class="grid items-start gap-4 lg:grid-cols-2">
	<svelte:boundary>
		{@const s = await setup}
		{@const g = await github}
		{@const a = await admins}
		<Card.Root data-testid="settings-general">
			<Card.Header>
				<Card.Title>This installation</Card.Title>
				<Card.Description>Set when granary starts (environment or flags); shown here for reference.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				<div class="grid gap-1">
					<div class="text-muted-foreground text-xs font-medium uppercase tracking-wide">Public URL (ORIGIN)</div>
					{#if s?.origin}
						<div class="flex flex-wrap items-center gap-2"><code class="bg-muted rounded px-1.5 py-0.5 break-all">{s.origin}</code><CopyButton text={s.origin} /></div>
					{:else}
						<p class="text-muted-foreground">Not set. Set <code>ORIGIN</code> to the URL people and GitHub use to reach granary.</p>
					{/if}
				</div>
				<div class="grid gap-1">
					<div class="text-muted-foreground text-xs font-medium uppercase tracking-wide">Webhook URL</div>
					<div class="flex flex-wrap items-center gap-2"><code class="bg-muted rounded px-1.5 py-0.5 break-all">{g.webhookUrl}</code><CopyButton text={g.webhookUrl} /></div>
					<p class="text-muted-foreground text-xs">Set up automatically when you create the GitHub App.</p>
				</div>
				<div class="grid gap-1">
					<div class="text-muted-foreground text-xs font-medium uppercase tracking-wide">Master key</div>
					{#if s?.masterKey === 'ok'}
						<p class="flex items-center gap-1.5"><CheckCircleIcon class="size-4 text-emerald-600 dark:text-emerald-400" /> Present. Keep a copy in your password manager — secrets and off-site backups need it.</p>
					{:else}
						<p class="flex items-center gap-1.5"><CircleDashedIcon class="size-4 text-amber-600 dark:text-amber-400" /> Missing. Webhooks are still received, but nothing that needs secrets runs. Run <code>granary init</code> on the server.</p>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>

		{@const steps = s?.steps ?? []}
		{@const open = steps.filter((st) => !st.optional && st.status !== 'done')}
		<Card.Root data-testid="settings-setup">
			<Card.Header>
				<Card.Title>Setup</Card.Title>
				<Card.Description>
					{#if open.length === 0}granary is set up.{:else if open.length === 1}One step left: {open[0]!.title.toLowerCase()}.{:else}{open.length} steps left.{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-3 text-sm">
				<ol class="grid gap-3">
					{#each steps as st (st.id)}
						<li class="flex items-start gap-2" data-testid="setup-step" data-step={st.id} data-status={st.status}>
							{#if st.status === 'done'}
								<CheckCircleIcon class="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
							{:else if st.status === 'attention'}
								<CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
							{:else}
								<CircleDashedIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
							{/if}
							<span class="grid gap-0.5">
								<span>
									<a class="font-medium underline-offset-2 hover:underline" href={st.href}>{st.title}</a>
									{#if st.optional}<Badge variant="secondary" class="ml-1">optional</Badge>{/if}
								</span>
								<span class="text-muted-foreground text-xs">{st.detail}</span>
							</span>
						</li>
					{/each}
				</ol>
				{#if g.mode === 'app'}<p class="text-muted-foreground text-xs">Connected as <a class="underline-offset-2 hover:underline" href="/settings/github">{MODE_LABEL[g.mode]}</a>; {a.length} {a.length === 1 ? 'admin' : 'admins'}.</p>{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root class="lg:col-span-2">
			<Card.Header>
				<Card.Title>Where settings come from</Card.Title>
				<Card.Description>Highest first. Environment variables for in-product settings are only seeds: they fill a value that is missing and never overwrite a change made here.</Card.Description>
			</Card.Header>
			<Card.Content>
				<ol class="text-muted-foreground grid gap-1.5 text-sm">
					<li><span class="text-foreground font-medium">Command-line flags</span> — <code>granary serve --data …</code></li>
					<li><span class="text-foreground font-medium">Process environment</span> — ORIGIN, HOST, PORT, proxy headers, data dir, master key</li>
					<li><span class="text-foreground font-medium"><code>granary.env</code> in the data directory</span> — same keys, for systemd setups</li>
					<li><span class="text-foreground font-medium">In-product settings</span> — GitHub connection, admins, allowlist, backups, telemetry (these pages, or <code>granary config get|set</code>)</li>
					<li><span class="text-foreground font-medium">Defaults</span></li>
				</ol>
			</Card.Content>
		</Card.Root>

		{#snippet pending()}
			<Skeleton class="h-56 rounded-xl" /><Skeleton class="h-56 rounded-xl" />
		{/snippet}
		{#snippet failed(error, reset)}
			<div class="lg:col-span-2"><ErrorAlert {error} retry={() => { void setup.refresh(); void github.refresh(); void admins.refresh(); reset(); }} /></div>
		{/snippet}
	</svelte:boundary>
</div>
