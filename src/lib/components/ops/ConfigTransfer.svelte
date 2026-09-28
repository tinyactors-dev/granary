<!-- Config export/import (ADR 0102): JSON without secret values; secrets are referenced by id. -->
<script lang="ts">
	import type { ConfigExport, ImportResult } from '$lib/ops/contract';
	import { Button } from '$lib/components/ui/button/index.js';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import { describeError } from '$lib/components/app/format';
	import { exportOpsConfig, importOpsConfig } from '$lib/remote/ops.remote';

	let exporting = $state(false);
	let importing = $state(false);
	let pending = $state<ConfigExport | null>(null);
	let parseError = $state<string | null>(null);
	let result = $state<ImportResult | null>(null);

	async function download() {
		exporting = true;
		try {
			const cfg = await exportOpsConfig();
			const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = `granary-ops-config-${new Date(cfg.exportedAt).toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(a.href);
		} catch (e) {
			toast.error('Export failed', { description: describeError(e).message });
		} finally {
			exporting = false;
		}
	}

	async function pick(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		pending = null;
		result = null;
		parseError = null;
		if (!file) return;
		try {
			const json = JSON.parse(await file.text());
			if (json?.format !== 'granary-ops-config/1') throw new Error('Not a granary ops config export (format granary-ops-config/1).');
			pending = json;
		} catch (err) {
			parseError = describeError(err).message;
		}
	}

	async function apply() {
		if (!pending) return;
		importing = true;
		try {
			result = await importOpsConfig(pending);
			toast.success('Config imported', { description: `${result.created} created, ${result.updated} updated, ${result.skipped} skipped.` });
			pending = null;
		} catch (e) {
			toast.error('Import failed', { description: describeError(e).message });
		} finally {
			importing = false;
		}
	}
</script>

<div class="grid gap-4 text-sm" data-testid="config-transfer">
	<p class="text-muted-foreground">Destinations, plans, sinks and budgets as JSON. Secret <em>values</em> are never exported — only which secrets are referenced, so you set them again after importing.</p>
	<AdminOnly reason="Only admins can export or import config">
		{#snippet children({ disabled })}
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="outline" {disabled} onclick={download}>{#if exporting}<LoaderCircleIcon class="animate-spin" />{:else}<DownloadIcon />{/if} Export</Button>
				<label class="border-input hover:bg-muted inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 font-medium {disabled ? 'pointer-events-none opacity-50' : ''}">
					<UploadIcon class="size-4" /> Choose a file to import
					<input type="file" accept="application/json,.json" class="sr-only" {disabled} onchange={pick} />
				</label>
			</div>
		{/snippet}
	</AdminOnly>
	{#if parseError}<p class="text-destructive">{parseError}</p>{/if}
	{#if pending}
		<div class="grid gap-2 rounded-md border p-3">
			<p>
				This file has {pending.destinations.length} destination{pending.destinations.length === 1 ? '' : 's'}, {pending.plans.length} plan{pending.plans.length === 1 ? '' : 's'}
				and {pending.sinks.length} sink{pending.sinks.length === 1 ? '' : 's'}, referencing {pending.secretRefs.length} secret{pending.secretRefs.length === 1 ? '' : 's'}.
				Items you edited in the UI are not overwritten by seeds.
			</p>
			<JsonBlock value={pending} preset="compact" rootLabel="import" />
			<Button class="w-fit" disabled={importing} onclick={apply}>{#if importing}<LoaderCircleIcon class="animate-spin" />{/if} Import</Button>
		</div>
	{/if}
	{#if result}
		<p>Imported: {result.created} created, {result.updated} updated, {result.skipped} skipped.
			{#if result.missingSecrets.length}Set these secrets next: {result.missingSecrets.join(', ')} (<a class="underline" href="/ops/secrets">Secrets</a>).{/if}</p>
	{/if}
</div>
