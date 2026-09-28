<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { isAdmin } from '$lib/components/app/session';
	import { KIND_LABEL, bytes, destinationWhere } from '$lib/components/ops/format';
	import { listOpsDestinations } from '$lib/remote/ops.remote';

	const destinations = listOpsDestinations();
</script>

<PageHeader title="Destinations" description="Where encrypted backups are stored. At least one should be off-site.">
	{#snippet actions()}
		{#if isAdmin()}<Button href="/ops/destinations/new"><PlusIcon /> Add destination</Button>{/if}
	{/snippet}
</PageHeader>

<svelte:boundary>
	<div class="grid gap-4 md:grid-cols-2">
		{#each await destinations as d (d.id)}
			<a href="/ops/destinations/{d.id}" class="group" data-testid="ops-destination">
				<Card.Root class="group-hover:border-foreground/20 h-full transition-colors">
					<Card.Header>
						<Card.Title class="flex flex-wrap items-center gap-2">
							{d.name}
							<StateBadge state={d.enabled ? 'enabled' : 'disabled'} tone={d.enabled ? 'success' : 'muted'} />
							{#if d.origin === 'seed'}<StateBadge state="seeded" tone="info" />{/if}
						</Card.Title>
						<Card.Description>{KIND_LABEL[d.settings.kind]}{d.settings.kind === 'r2' ? ` · ${d.settings.jurisdiction.toUpperCase()} jurisdiction` : ''}</Card.Description>
					</Card.Header>
					<Card.Content class="text-muted-foreground grid gap-1 text-sm">
						<code class="text-foreground truncate text-xs">{destinationWhere(d.settings)}</code>
						<span>Caps: {bytes(d.caps.maxBytes)}, {d.caps.maxBackupsPerDatabase} backups per database</span>
						<span>
							Last test:
							{#if d.lastTest}{d.lastTest.ok ? 'passed' : 'failed'} <RelativeTime ms={d.lastTest.at} />{:else}never{/if}
						</span>
						<span class="flex items-center gap-1"><LockIcon class="size-3.5" /> encrypted</span>
					</Card.Content>
				</Card.Root>
			</a>
		{:else}
			<p class="text-muted-foreground text-sm">No destinations yet.</p>
		{/each}
	</div>
	{#snippet failed(error, reset)}<ErrorAlert {error} retry={() => { void destinations.refresh(); reset(); }} />{/snippet}
</svelte:boundary>
