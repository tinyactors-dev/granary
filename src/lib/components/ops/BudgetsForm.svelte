<!-- Egress budget and disk/memory thresholds (ADR 0098, 0107, 0108). Relative to what the VM reports. -->
<script lang="ts">
	import type { Budgets } from '$lib/ops/contract';
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import SaveIcon from '@lucide/svelte/icons/save';
	import { toast } from 'svelte-sonner';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';
	import { saveOpsBudgets } from '$lib/remote/ops.remote';
	import { GiB, fieldIssues } from './format';

	let { budgets }: { budgets: Budgets } = $props();
	const b0 = untrack(() => $state.snapshot(budgets));
	const admin = $derived(isAdmin());

	let egressGiB = $state(b0.r2EgressBytesPerMonth / GiB);
	let minFreeGiB = $state(b0.disk.minFreeBytes / GiB);
	let minFreePct = $state(Math.round(b0.disk.minFreeRatio * 100));
	let attentionPct = $state(Math.round(b0.disk.attentionFreeRatio * 100));
	let localCopyPct = $state(Math.round(b0.disk.localCopyMinFreeRatio * 100));
	let rssPct = $state(Math.round(b0.memory.attentionRssRatio * 100));
	let issues = $state<Record<string, string>>({});
	let saving = $state(false);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		issues = {};
		try {
			await saveOpsBudgets({
				r2EgressBytesPerMonth: Math.round(egressGiB * GiB),
				disk: { minFreeBytes: Math.round(minFreeGiB * GiB), minFreeRatio: minFreePct / 100, attentionFreeRatio: attentionPct / 100, localCopyMinFreeRatio: localCopyPct / 100 },
				memory: { attentionRssRatio: rssPct / 100 },
				version: b0.version
			});
			toast.success('Budgets saved');
		} catch (err) {
			const msg = describeError(err).message;
			issues = fieldIssues(msg);
			toast.error('Could not save', { description: msg });
		} finally {
			saving = false;
		}
	}

	const FIELDS = [
		{ id: 'egress', key: 'r2EgressBytesPerMonth', label: 'R2 upload budget per month (GiB)', hint: 'Counts uploads to off-site storage, which most hosts bill as outbound traffic. When uploads would exceed it, the backup interval stretches (up to 6 h) instead.', min: 1, max: 2048, step: 1 },
		{ id: 'minfree', key: 'disk.minFreeBytes', label: 'Keep free after a snapshot (GiB)', hint: 'A backup starts only if free space minus the database size stays above this…', min: 0, max: 1024, step: 0.5 },
		{ id: 'minfreepct', key: 'disk.minFreeRatio', label: '…and above this share of the disk (%)', hint: 'Whichever is larger wins.', min: 0, max: 50, step: 1 },
		{ id: 'attn', key: 'disk.attentionFreeRatio', label: 'Mention low disk below (%)', hint: 'After self-healing and a 24 h grace period.', min: 0, max: 90, step: 1 },
		{ id: 'local', key: 'disk.localCopyMinFreeRatio', label: 'Keep the local copy only above (%)', hint: 'The same-disk copy is dropped first when space is tight.', min: 0, max: 90, step: 1 },
		{ id: 'rss', key: 'memory.attentionRssRatio', label: 'Memory metric threshold (%)', hint: 'Exported to Grafana only; never needs you.', min: 10, max: 95, step: 1 }
	] as const;
</script>

<form class="grid gap-4 sm:grid-cols-2" onsubmit={save} data-testid="budgets-form">
	{#each FIELDS as f (f.id)}
		<div class="grid content-start gap-1.5">
			<Label for="b-{f.id}">{f.label}</Label>
			{#if f.id === 'egress'}<Input id="b-{f.id}" type="number" min={f.min} max={f.max} step={f.step} bind:value={egressGiB} disabled={!admin} />
			{:else if f.id === 'minfree'}<Input id="b-{f.id}" type="number" min={f.min} max={f.max} step={f.step} bind:value={minFreeGiB} disabled={!admin} />
			{:else if f.id === 'minfreepct'}<Input id="b-{f.id}" type="number" min={f.min} max={f.max} step={f.step} bind:value={minFreePct} disabled={!admin} />
			{:else if f.id === 'attn'}<Input id="b-{f.id}" type="number" min={f.min} max={f.max} step={f.step} bind:value={attentionPct} disabled={!admin} />
			{:else if f.id === 'local'}<Input id="b-{f.id}" type="number" min={f.min} max={f.max} step={f.step} bind:value={localCopyPct} disabled={!admin} />
			{:else}<Input id="b-{f.id}" type="number" min={f.min} max={f.max} step={f.step} bind:value={rssPct} disabled={!admin} />{/if}
			<p class="text-muted-foreground text-xs">{f.hint}</p>
			{#if issues[f.key]}<p class="text-destructive text-sm" data-testid="field-issue">{issues[f.key]}</p>{/if}
		</div>
	{/each}
	<div class="sm:col-span-2">
		<Button type="submit" disabled={!admin || saving}>{#if saving}<LoaderCircleIcon class="animate-spin" />{:else}<SaveIcon />{/if} Save budgets</Button>
	</div>
</form>
