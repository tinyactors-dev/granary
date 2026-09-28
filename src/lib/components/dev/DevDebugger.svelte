<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import BugIcon from '@lucide/svelte/icons/bug';
	import SendIcon from '@lucide/svelte/icons/send';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { toast } from 'svelte-sonner';
	import type { ActorSummary } from '$lib/schemas/api';
	import type { DevSendEventResult } from '$lib/schemas/dev';
	import { listActors } from '$lib/remote/actors.remote';
	import { devSendEvent } from '$lib/remote/dev.remote';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import { describeError, issueHref } from '$lib/components/app/format';
	import ActorQuickView from '$lib/components/actors/ActorQuickView.svelte';
	import { actorHref } from '$lib/components/actors/inspect';
	import LaunchConfig from './LaunchConfig.svelte';

	let { dapHost, dapPort }: { dapHost: string; dapPort: number } = $props();

	const actors = listActors();
	let expanded = $state<string | null>(null);

	// "send event" form (a command, so plain local state)
	let family = $state('issue');
	let name = $state('');
	let event = $state('');
	let data = $state('');
	let sending = $state(false);
	let lastResult = $state<{ target: string; result: DevSendEventResult } | null>(null);

	const dataError = $derived.by(() => {
		if (data.trim() === '') return null;
		try {
			JSON.parse(data);
			return null;
		} catch (e) {
			return (e as Error).message;
		}
	});
	const canSend = $derived(family.trim() !== '' && name.trim() !== '' && event.trim() !== '' && !dataError && !sending);

	function target(a: ActorSummary) {
		if (!a.address) return;
		family = a.address.family;
		name = a.address.name;
		document.getElementById('send-event')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	async function send(e: SubmitEvent) {
		e.preventDefault();
		if (!canSend) return;
		sending = true;
		const address = { family: family.trim(), name: name.trim() };
		try {
			const result = await devSendEvent({ address, event: event.trim(), ...(data.trim() ? { data } : {}) });
			lastResult = { target: `${address.family}/${address.name}`, result };
			toast.success(`Sent ${event} → ${address.family}/${address.name}`, { description: `status: ${result.status}` });
		} catch (err) {
			toast.error('Send failed', { description: describeError(err).message });
		} finally {
			sending = false;
		}
	}
</script>

<Card.Root id="debugger">
	<Card.Header>
		<Card.Title>Debugger</Card.Title>
		<Card.Description>
			The app runs a DAP server on <code>{dapHost}:{dapPort}</code>. Attach VS Code to any resident actor.
		</Card.Description>
		{#if actors}
			<Card.Action>
				<Button variant="outline" size="sm" onclick={() => actors.refresh()}><RefreshCwIcon class={actors.loading ? 'animate-spin' : ''} /> Refresh</Button>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content class="space-y-6">
		<Alert.Root>
			<InfoIcon />
			<Alert.Title>How to attach</Alert.Title>
			<Alert.Description>
				<ol class="list-decimal space-y-0.5 pl-4">
					<li>Install the <strong>tinyactors-vscode</strong> extension (provides the <code>tinyactors</code> debug type).</li>
					<li>Copy an actor's configuration below into <code>.vscode/launch.json</code>.</li>
					<li>Start debugging — the adapter connects to port <code>{dapPort}</code> and lets you <em>send</em>, <em>set</em>, <em>goto</em> and <em>evaluate</em>.</li>
				</ol>
			</Alert.Description>
		</Alert.Root>

			<svelte:boundary>
				{@const list = await actors}
				<ul class="divide-y rounded-lg border" data-testid="dev-actors">
					{#each list as a (a.id)}
						<li>
							<div class="flex flex-wrap items-center gap-2 px-3 py-2">
								<button
									type="button"
									class="flex min-w-0 flex-1 items-center gap-2 text-left"
									aria-expanded={expanded === a.id}
									onclick={() => (expanded = expanded === a.id ? null : a.id)}
									disabled={!a.address}
								>
									<ChevronRightIcon class="size-4 shrink-0 transition-transform {expanded === a.id ? 'rotate-90' : ''}" />
									<span class="truncate font-mono text-sm">{a.id}</span>
								</button>
								<div class="flex flex-wrap gap-1">
									{#each a.activeStates as s (s)}<span class="bg-muted rounded px-1.5 font-mono text-xs leading-5">{s}</span>{/each}
								</div>
								<StateBadge state={a.scheduling} />
								{#if a.address}
									<ActorQuickView address={a.address} />
									<Button href={actorHref(a.address)} variant="ghost" size="xs" data-testid="dev-inspect">Inspect</Button>
								{/if}
								{#if a.address?.family === 'issue'}
									<Button href={issueHref(a.address.name)} variant="ghost" size="xs">Details</Button>
								{/if}
								<Button variant="outline" size="xs" disabled={!a.address} onclick={() => target(a)}><SendIcon /> Send event</Button>
							</div>
							{#if expanded === a.id && a.address}
								<div class="border-t px-3 py-3"><LaunchConfig address={a.address} /></div>
							{/if}
						</li>
					{:else}
						<li class="text-muted-foreground px-3 py-6 text-center text-sm">No resident actors.</li>
					{/each}
				</ul>
				{#snippet failed(error, reset)}<ErrorAlert {error} retry={() => { void actors.refresh(); reset(); }} />{/snippet}
			</svelte:boundary>

		<form id="send-event" class="space-y-3 rounded-lg border p-4" onsubmit={send} data-testid="send-event-form">
			<h3 class="flex items-center gap-2 text-sm font-semibold"><BugIcon class="size-4" /> Send an event</h3>
			<div class="grid gap-3 sm:grid-cols-[8rem_1fr_1fr]">
				<div class="grid gap-1.5">
					<Label for="se-family">Family</Label>
					<Input id="se-family" class="font-mono" bind:value={family} />
				</div>
				<div class="grid gap-1.5">
					<Label for="se-name">Name</Label>
					<Input id="se-name" class="font-mono" placeholder="700001-3" bind:value={name} />
				</div>
				<div class="grid gap-1.5">
					<Label for="se-event">Event</Label>
					<Input id="se-event" class="font-mono" placeholder="check.timeout" list="known-events" bind:value={event} />
					<datalist id="known-events">
						{#each ['issue.opened', 'allowlist.check', 'allowlist.verdict', 'allowlist.replace', 'github.closed', 'github.gave-up', 'check.timeout'] as ev (ev)}<option value={ev}></option>{/each}
					</datalist>
				</div>
			</div>
			<div class="grid gap-1.5">
				<Label for="se-data">Data (JSON, optional)</Label>
				<Textarea id="se-data" rows={4} class="font-mono text-xs" placeholder={'{"login": "alice", "allowed": true, "reason": "allowlist"}'} bind:value={data} aria-invalid={dataError ? 'true' : undefined} />
				{#if dataError}<p class="text-destructive text-xs">Invalid JSON: {dataError}</p>{/if}
			</div>
			<Button type="submit" disabled={!canSend}><SendIcon class={sending ? 'animate-pulse' : ''} /> Send</Button>
			{#if lastResult}
				<div class="text-sm">
					<p class="text-muted-foreground mb-1">Result for <code>{lastResult.target}</code>:</p>
					<JsonBlock value={lastResult.result} preset="compact" rootLabel="result" />
				</div>
			{/if}
		</form>
	</Card.Content>
</Card.Root>
