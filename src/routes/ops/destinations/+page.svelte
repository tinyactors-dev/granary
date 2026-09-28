<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { isAdmin } from '$lib/components/app/session';
	import { KIND_LABEL, bytes, destinationWhere } from '$lib/components/ops/format';
	import { getOpsStatus, listOpsDestinations, listOpsDrills } from '$lib/remote/ops.remote';
	import ExternalLink from '$lib/components/ops/ExternalLink.svelte';
	import { destinationConsoleLink } from '$lib/ops/contract';

	const destinations = listOpsDestinations();
	const status = getOpsStatus();
	const drills = listOpsDrills({ limit: 100 });

	/** Newest verified upload (any database) and newest finished restore drill, per destination. */
	const lastUpload = (id: string) =>
		(status.current?.backups ?? []).filter((b) => b.destinationId === id && b.lastVerifiedAt !== null).reduce<number | null>((m, b) => Math.max(m ?? 0, b.lastVerifiedAt!), null);
	const lastDrill = (id: string) => (drills.current?.items ?? []).find((d) => d.destinationId === id && d.finishedAt !== null) ?? null;
</script>

<PageHeader
	title="Destinations"
	description="Where backups are stored. Every backup is compressed and encrypted before it leaves the host; at least one destination should be off-site."
>
	{#snippet actions()}
		{#if isAdmin()}<Button href="/ops/destinations/new"><PlusIcon /> Add destination</Button>{/if}
	{/snippet}
</PageHeader>

<svelte:boundary>
	<div class="grid gap-4 md:grid-cols-2">
		{#each await destinations as d (d.id)}
			{@const link = destinationConsoleLink(d)}
			<div class="grid content-start gap-1.5">
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
						{@const up = lastUpload(d.id)}
						{@const dr = lastDrill(d.id)}
						<span data-testid="destination-last-upload">Last verified backup: {#if up}<RelativeTime ms={up} />{:else}none yet{/if}</span>
						<span data-testid="destination-last-drill">
							Last restore drill:
							{#if dr}{dr.result === 'ok' ? 'passed' : 'failed'} <RelativeTime ms={dr.finishedAt!} />{:else}none yet{/if}
						</span>
						<span>
							Connection test:
							{#if d.lastTest}{d.lastTest.ok ? 'passed' : 'failed'} <RelativeTime ms={d.lastTest.at} />{:else}not run{/if}
						</span>
					</Card.Content>
				</Card.Root>
			</a>
			{#if link}<ExternalLink href={link.url} label={link.label} class="text-muted-foreground px-1 text-xs" />{/if}
			</div>
		{:else}
			<p class="text-muted-foreground text-sm">No destinations yet.</p>
		{/each}
	</div>
	{#snippet failed(error, reset)}<ErrorAlert {error} retry={() => { void destinations.refresh(); reset(); }} />{/snippet}
</svelte:boundary>
