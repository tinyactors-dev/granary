<script lang="ts">
	import type { UploadSummary } from '$lib/ops/contract';
	import { page } from '$app/state';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import { describeError } from '$lib/components/app/format';
	import { UPLOAD_STEPS, bytes, duration, runTone, uploadTone } from '$lib/components/ops/format';
	import { getOpsDownloadLink, getOpsRun, listOpsDestinations } from '$lib/remote/ops.remote';
	import ExternalLink from '$lib/components/ops/ExternalLink.svelte';
	import { destinationConsoleLink } from '$lib/ops/contract';

	const runId = $derived(page.params.runId ?? '');
	const detail = $derived(getOpsRun({ id: runId }));
	const destinations = listOpsDestinations();
	let fetching = $state<string | null>(null);

	async function download(u: UploadSummary) {
		fetching = u.destinationId;
		try {
			const link = await getOpsDownloadLink({ runId: u.runId, destinationId: u.destinationId });
			window.open(link.url, '_blank', 'noopener');
			toast.success('Download link opened', { description: 'It expires in a few minutes. The file is encrypted; restore it with ops:restore.' });
		} catch (e) {
			toast.error('No download link', { description: describeError(e).message });
		} finally {
			fetching = null;
		}
	}

	/** Index of an upload state on the happy path; failures map to where they stopped. */
	const stepIndex = (s: UploadSummary['state']) => (s === 'retry-wait' ? 2 : s === 'failed' ? -1 : UPLOAD_STEPS.indexOf(s));
</script>

<svelte:boundary>
	{@const d = await detail}
	{@const dests = await destinations}
	{#if !d}
		<PageHeader title="Unknown run" description={runId} />
		<p class="text-muted-foreground text-sm"><a class="underline" href="/ops/backups">Back to backups</a></p>
	{:else}
		{@const r = d.run}
		<PageHeader title="Backup {r.database}" description="{r.id} · {r.trigger} · attempt {r.attempt}">
			{#snippet actions()}<StateBadge state={r.state} tone={runTone(r.state)} />{/snippet}
		</PageHeader>

		<dl class="bg-card grid grid-cols-2 gap-4 rounded-xl border p-4 text-sm sm:grid-cols-4">
			<div><dt class="text-muted-foreground">Started</dt><dd><RelativeTime ms={r.startedAt} /></dd></div>
			<div><dt class="text-muted-foreground">Took</dt><dd>{r.finishedAt ? duration(r.finishedAt - r.startedAt) : 'still running'}</dd></div>
			<div><dt class="text-muted-foreground">Snapshot</dt><dd class="tabular-nums">{bytes(r.rawBytes)}</dd></div>
			<div><dt class="text-muted-foreground">Compressed + encrypted</dt><dd class="tabular-nums">{bytes(r.sealedBytes)}</dd></div>
		</dl>
		{#if r.error}<p class="text-sm"><span class="text-muted-foreground">What went wrong:</span> {r.error}</p>{/if}

		<div class="grid gap-4 lg:grid-cols-2">
			{#each d.uploads as u (u.destinationId)}
				{@const dest = dests.find((x) => x.id === u.destinationId)}
				{@const at = stepIndex(u.state)}
				<Card.Root data-testid="ops-upload">
					<Card.Header>
						<Card.Title class="flex flex-wrap items-center gap-2">
							{dest?.name ?? u.destinationId} <StateBadge state={u.state} tone={uploadTone(u.state)} />
							{@const link = dest ? destinationConsoleLink(dest) : null}
							{#if link}<ExternalLink href={link.url} label={link.label} class="ml-auto text-xs font-normal" />{/if}
						</Card.Title>
						<Card.Description class="font-mono text-xs break-all">{u.artifactKey ?? 'no object yet'}</Card.Description>
					</Card.Header>
					<Card.Content class="grid gap-3 text-sm">
						<ol class="flex flex-wrap items-center gap-1 text-xs" aria-label="Upload steps">
							{#each UPLOAD_STEPS.slice(1) as step, i (step)}
								{@const reached = at >= i + 1}
								<li class="rounded-full border px-2 py-0.5 {reached ? 'border-emerald-600/30 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300' : 'text-muted-foreground'}">{step}</li>
								{#if i < UPLOAD_STEPS.length - 2}<li aria-hidden="true" class="text-muted-foreground">→</li>{/if}
							{/each}
						</ol>
						<p class="text-muted-foreground">
							{u.attempts} attempt{u.attempts === 1 ? '' : 's'} · {bytes(u.uploadedBytes)} uploaded · updated <RelativeTime ms={u.updatedAt} />
							{#if u.nextAttemptAt} · next try <RelativeTime ms={u.nextAttemptAt} />{/if}
						</p>
						{#if u.lastError}
							<div class="rounded-md border p-2 text-xs">
								<p><strong>{u.lastError.code}</strong>{u.lastError.status ? ` (${u.lastError.status}${u.lastError.providerCode ? ' ' + u.lastError.providerCode : ''})` : ''}: {u.lastError.message}</p>
								<p class="text-muted-foreground">{u.lastError.retryable ? 'Retried automatically.' : 'Not retryable — needs a config change.'}</p>
							</div>
						{/if}
						{#if u.state === 'done'}
							<AdminOnly reason="Only admins can download backups">
								{#snippet children({ disabled })}
									<Button variant="outline" size="sm" class="w-fit" disabled={disabled || fetching === u.destinationId} onclick={() => download(u)}>
										{#if fetching === u.destinationId}<LoaderCircleIcon class="animate-spin" />{:else}<DownloadIcon />{/if} Download (encrypted)
									</Button>
								{/snippet}
							</AdminOnly>
						{/if}
					</Card.Content>
				</Card.Root>
			{:else}
				<p class="text-muted-foreground text-sm">No uploads yet — the snapshot is still being taken.</p>
			{/each}
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Restore this backup</Card.Title>
				<Card.Description>Backups are always encrypted; the restore tool needs GRANARY_MASTER_KEY (from fnox) and the destination's credentials.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-2">
				{#each d.uploads.filter((u) => u.state === 'done') as u (u.destinationId)}
					{@const cmd = `mise run ops:restore -- --dest ${u.destinationId} --run ${r.id} --out ${r.database}.sqlite`}
					<div class="bg-muted flex items-center gap-2 rounded-md px-3 py-2">
						<code class="min-w-0 flex-1 overflow-x-auto text-xs whitespace-nowrap">{cmd}</code>
						<CopyButton text={cmd} />
					</div>
				{:else}
					<p class="text-muted-foreground text-sm">Nothing restorable yet.</p>
				{/each}
			</Card.Content>
		</Card.Root>

		{#if d.manifest}
			<Card.Root>
				<Card.Header>
					<Card.Title>Manifest</Card.Title>
					<Card.Description>Written last — its presence is what commits the backup.</Card.Description>
				</Card.Header>
				<Card.Content><JsonBlock value={d.manifest} preset="panel" rootLabel="manifest" expandDepth={1} /></Card.Content>
			</Card.Root>
		{/if}
	{/if}
	{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
</svelte:boundary>
