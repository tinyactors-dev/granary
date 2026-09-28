<!-- Create/edit a backup plan (ADR 0082, 0098). -->
<script lang="ts">
	import type { BackupPlan, Destination } from '$lib/ops/contract';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import { describeError } from '$lib/components/app/format';
	import { saveOpsPlan } from '$lib/remote/ops.remote';
	import NativeSelect from './NativeSelect.svelte';
	import { DRILL_PRESETS, HOUR, INTERVAL_PRESETS, fieldIssues, duration } from './format';

	let {
		open = $bindable(false),
		plan,
		destinations,
		databases
	}: { open?: boolean; plan: BackupPlan | null; destinations: Destination[]; databases: string[] } = $props();

	let name = $state('');
	let enabled = $state(true);
	let dbs = $state<string[]>([]);
	let dests = $state<string[]>([]);
	let intervalMs = $state(HOUR);
	let drillIntervalMs = $state(7 * 24 * HOUR);
	let issues = $state<Record<string, string>>({});
	let saving = $state(false);

	$effect(() => {
		if (!open) return;
		name = plan?.name ?? 'Hourly backups';
		enabled = plan?.enabled ?? true;
		dbs = [...(plan?.databases ?? databases)];
		dests = [...(plan?.destinationIds ?? destinations.filter((d) => d.enabled).map((d) => d.id))];
		intervalMs = plan?.intervalMs ?? HOUR;
		drillIntervalMs = plan?.drillIntervalMs ?? 7 * 24 * HOUR;
		issues = {};
	});

	const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
	const intervals = $derived(INTERVAL_PRESETS.some((p) => p.ms === intervalMs) ? INTERVAL_PRESETS : [...INTERVAL_PRESETS, { ms: intervalMs, label: `Every ${duration(intervalMs)}` }]);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const i: Record<string, string> = {};
		if (!name.trim()) i.name = 'Required';
		if (!dbs.length) i.databases = 'Pick at least one database';
		if (!dests.length) i.destinationIds = 'Pick at least one destination';
		issues = i;
		if (Object.keys(i).length) return;
		saving = true;
		try {
			const saved = await saveOpsPlan({
				...(plan ? { id: plan.id, version: plan.version } : {}),
				name: name.trim(),
				enabled,
				databases: dbs,
				destinationIds: dests,
				intervalMs: Number(intervalMs),
				drillIntervalMs: Number(drillIntervalMs)
			});
			toast.success(`Saved "${saved.name}"`);
			open = false;
		} catch (err) {
			const msg = describeError(err).message;
			issues = fieldIssues(msg);
			toast.error('Could not save the plan', { description: msg });
		} finally {
			saving = false;
		}
	}
</script>

{#snippet err(key: string)}
	{#if issues[key]}<p class="text-destructive text-sm" data-testid="field-issue">{issues[key]}</p>{/if}
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{plan ? `Edit "${plan.name}"` : 'New backup plan'}</Dialog.Title>
			<Dialog.Description>Which databases, where to, and how often. The interval stretches automatically if uploads would exceed the egress budget.</Dialog.Description>
		</Dialog.Header>
		<form class="grid gap-4" onsubmit={save} data-testid="plan-form">
			<div class="grid content-start gap-1.5">
				<Label for="p-name">Name</Label>
				<Input id="p-name" bind:value={name} />
				{@render err('name')}
			</div>
			<fieldset class="grid gap-1.5">
				<legend class="mb-1.5 text-sm font-medium">Databases</legend>
				{#each databases as db (db)}
					<label class="flex items-center gap-2 text-sm"><input type="checkbox" checked={dbs.includes(db)} onchange={() => (dbs = toggle(dbs, db))} /> {db}</label>
				{/each}
				{@render err('databases')}
			</fieldset>
			<fieldset class="grid gap-1.5">
				<legend class="mb-1.5 text-sm font-medium">Destinations</legend>
				{#each destinations as d (d.id)}
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={dests.includes(d.id)} onchange={() => (dests = toggle(dests, d.id))} /> {d.name}
						{#if !d.enabled}<span class="text-muted-foreground text-xs">(disabled)</span>{/if}
					</label>
				{/each}
				{@render err('destinationIds')}
			</fieldset>
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="grid content-start gap-1.5">
					<Label for="p-int">Back up</Label>
					<NativeSelect id="p-int" bind:value={intervalMs}>
						{#each intervals as p (p.ms)}<option value={p.ms}>{p.label}</option>{/each}
					</NativeSelect>
					{@render err('intervalMs')}
				</div>
				<div class="grid content-start gap-1.5">
					<Label for="p-drill">Restore drill</Label>
					<NativeSelect id="p-drill" bind:value={drillIntervalMs}>
						{#each DRILL_PRESETS as p (p.ms)}<option value={p.ms}>{p.label}</option>{/each}
					</NativeSelect>
				</div>
			</div>
			<label class="flex items-center gap-2 text-sm"><Switch bind:checked={enabled} /> Enabled</label>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" disabled={saving}>{#if saving}<LoaderCircleIcon class="animate-spin" />{/if} Save</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
