<!--
	Admin → Sandbox (ADR 0315): use the sandbox on this machine (ADR 0312)
	through this instance, without an SSH tunnel, or see how to set one up.
-->
<script lang="ts">
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import InfoIcon from '@lucide/svelte/icons/info';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import { toast } from 'svelte-sonner';
	import { enterSandbox, getSandboxInfo } from '$lib/remote/sandbox.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';

	const info = getSandboxInfo();
	let entering = $state(false);

	async function enter() {
		entering = true;
		try {
			const { next } = await enterSandbox();
			// A full load: from now on the sandbox serves this browser.
			location.assign(next);
		} catch (e) {
			entering = false;
			toast.error(e instanceof Error ? e.message : 'Could not enter the sandbox');
			void info.refresh();
		}
	}
</script>

<PageHeader title="Sandbox" description="A throwaway granary on the fake GitHub, next to this one" />

<svelte:boundary>
	{@const s = await info}
	{#if s.state === 'self'}
		<Alert.Root data-testid="sandbox-self">
			<InfoIcon />
			<Alert.Title>You are in the sandbox</Alert.Title>
			<Alert.Description>Everything here runs against the fake GitHub on this machine. Use Fake GitHub in the sidebar to play the GitHub side.</Alert.Description>
		</Alert.Root>
	{:else if s.state === 'up'}
		<Card.Root data-testid="sandbox-up">
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><CircleCheckIcon class="size-5 text-emerald-600 dark:text-emerald-400" />A sandbox is running on this machine</Card.Title>
				<Card.Description>
					Version {s.version} at <code>{s.url}</code>. Entering it switches this browser to the sandbox until you click
					“Back to production” in its amber strip. The real instance, its data and github.com are not touched.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<p class="text-muted-foreground mb-3 text-sm">The sandbox has its own sign-in: pick any login on its Sessions page.</p>
				<Button onclick={enter} disabled={entering} class="w-full sm:w-auto" data-testid="sandbox-enter">{entering ? 'Entering…' : 'Enter the sandbox'}</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<Alert.Root data-testid="sandbox-unavailable">
			{#if s.state === 'off'}<InfoIcon />{:else}<CircleXIcon />{/if}
			<Alert.Title>
				{#if s.state === 'off'}Turned off here{:else if s.state === 'not-a-sandbox'}Something else answers at {s.url}{:else}No sandbox is running on this machine{/if}
			</Alert.Title>
			<Alert.Description>
				{#if s.state === 'off'}
					GRANARY_SANDBOX_URL is empty, so this instance never forwards to a sandbox.
				{:else if s.state === 'not-a-sandbox'}
					It is not a granary sandbox, so this instance will not forward anyone to it. Set GRANARY_SANDBOX_URL to where your sandbox listens.
				{:else}
					Nothing answers at <code>{s.url}</code>. Set one up once on the host; then come back here.
				{/if}
			</Alert.Description>
		</Alert.Root>
		{#if s.state !== 'off'}
			<Card.Root class="mt-4" data-testid="sandbox-setup">
				<Card.Header>
					<Card.Title>Set up the sandbox</Card.Title>
					<Card.Description>On this host, as a user with sudo. It gets its own data, key and fake GitHub, listens on 127.0.0.1 only, and its links point here.</Card.Description>
				</Card.Header>
				<Card.Content>
					<pre class="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed" data-testid="sandbox-setup-commands">{s.setup.join('\n')}</pre>
					<p class="text-muted-foreground mt-3 text-sm">
						After an update, restart it too: <code>sudo systemctl restart granary-sandbox</code>.
					</p>
				</Card.Content>
			</Card.Root>
		{/if}
	{/if}
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void info.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
