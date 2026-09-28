<!-- Create a scenario: preset, seed, rates, persona mix (ADR 0072, 0076). -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import DicesIcon from '@lucide/svelte/icons/dices';
	import { createScenario } from '$lib/remote/load.remote';
	import { describeError } from '$lib/components/app/format';
	import NativeSelect from '../NativeSelect.svelte';
	import KindIcon from './KindIcon.svelte';
	import { KIND_LABEL, scenarioHref } from './meta';
	import { PERSONA_KINDS, type PersonaKind, type PersonaKindInfo, type PresetInfo, type PresetName } from '$lib/schemas/dev';

	let { presets, kinds, busy = false }: { presets: PresetInfo[]; kinds: PersonaKindInfo[]; busy?: boolean } = $props();

	let preset = $state<PresetName>('smoke');
	const presetInfo = $derived(presets.find((p) => p.name === preset) ?? presets[0]);

	let seed = $state(Math.floor(Math.random() * 100000));
	let personas = $state(12);
	let rate = $state(60);
	let durationS = $state(30);
	let rampS = $state(5);
	let timeScale = $state(0.2);
	let mix = $state<Record<PersonaKind, number>>(Object.fromEntries(PERSONA_KINDS.map((k) => [k, 1])) as Record<PersonaKind, number>);
	let submitting = $state(false);

	/** Load a preset's values into the form. */
	function applyPreset(p: PresetInfo | undefined) {
		if (!p) return;
		personas = p.config.personas;
		rate = p.config.arrivalRatePerMin;
		durationS = Math.round(p.config.durationMs / 1000);
		rampS = Math.round(p.config.rampUpMs / 1000);
		timeScale = p.config.timeScale;
		mix = Object.fromEntries(PERSONA_KINDS.map((k) => [k, p.config.mix[k] ?? 0])) as Record<PersonaKind, number>;
	}
	$effect(() => applyPreset(presetInfo));

	const totalWeight = $derived(PERSONA_KINDS.reduce((s, k) => s + (mix[k] ?? 0), 0));
	const describe = (k: PersonaKind) => kinds.find((x) => x.kind === k)?.description ?? '';

	async function submit(start: boolean) {
		submitting = true;
		try {
			const created = await createScenario({
				preset,
				start,
				config: {
					seed: Math.max(0, Math.floor(seed)),
					personas: Math.floor(personas),
					arrivalRatePerMin: rate,
					durationMs: Math.round(durationS * 1000),
					rampUpMs: Math.round(rampS * 1000),
					timeScale,
					mix: { ...mix }
				}
			});
			toast.success(`Scenario ${created.id} ${start ? 'started' : 'created'} — ${created.personasPlanned} personas planned`);
			await goto(scenarioHref(created.id), { noScroll: true });
		} catch (e) {
			toast.error(describeError(e).message);
		} finally {
			submitting = false;
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>New scenario</Card.Title>
		<Card.Description>{presetInfo?.description}</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<div class="col-span-2 space-y-1.5">
				<Label for="lg-preset">Preset</Label>
				<NativeSelect id="lg-preset" bind:value={preset} class="w-full">
					{#each presets as p (p.name)}<option value={p.name}>{p.name}</option>{/each}
				</NativeSelect>
			</div>
			<div class="col-span-2 space-y-1.5">
				<Label for="lg-seed">Seed</Label>
				<div class="flex gap-1.5">
					<Input id="lg-seed" type="number" min="0" bind:value={seed} class="font-mono" />
					<Button variant="outline" size="icon" onclick={() => (seed = Math.floor(Math.random() * 100000))} title="Random seed" aria-label="Random seed"><DicesIcon /></Button>
				</div>
			</div>
			<div class="space-y-1.5">
				<Label for="lg-personas">Personas</Label>
				<Input id="lg-personas" type="number" min="1" max="500" bind:value={personas} />
			</div>
			<div class="space-y-1.5">
				<Label for="lg-rate">Arrivals / min</Label>
				<Input id="lg-rate" type="number" min="1" max="1200" bind:value={rate} />
			</div>
			<div class="space-y-1.5">
				<Label for="lg-duration">Duration (s)</Label>
				<Input id="lg-duration" type="number" min="1" max="3600" bind:value={durationS} />
			</div>
			<div class="space-y-1.5">
				<Label for="lg-ramp">Ramp-up (s)</Label>
				<Input id="lg-ramp" type="number" min="0" max="3600" bind:value={rampS} />
			</div>
			<div class="col-span-2 space-y-1.5 sm:col-span-4">
				<Label for="lg-ts">Think-time scale <span class="text-muted-foreground font-normal">× {timeScale.toFixed(2)} (1 = human pace)</span></Label>
				<input id="lg-ts" type="range" min="0.05" max="2" step="0.05" bind:value={timeScale} class="accent-primary w-full" />
			</div>
		</div>

		<fieldset class="space-y-2">
			<legend class="text-sm font-medium">Persona mix <span class="text-muted-foreground font-normal">(relative weights)</span></legend>
			<div class="grid gap-y-1.5">
				{#each PERSONA_KINDS as k (k)}
					{@const share = totalWeight > 0 ? Math.round(((mix[k] ?? 0) / totalWeight) * 100) : 0}
					<label class="grid grid-cols-[1.25rem_minmax(0,11rem)_minmax(0,1fr)_2.75rem] items-center gap-2 text-sm" title={describe(k)}>
						<KindIcon kind={k} class="text-muted-foreground size-4" />
						<span class="truncate">{KIND_LABEL[k]}</span>
						<input type="range" min="0" max="10" step="0.5" bind:value={mix[k]} class="accent-primary w-full" aria-label="{KIND_LABEL[k]} weight" />
						<span class="text-muted-foreground text-right text-xs tabular-nums">{share}%</span>
					</label>
				{/each}
			</div>
		</fieldset>
	</Card.Content>
	<Card.Footer class="flex flex-wrap justify-end gap-2">
		<Button variant="outline" disabled={submitting || totalWeight <= 0} onclick={() => submit(false)}><PlusIcon /> Create</Button>
		<Button disabled={submitting || busy || totalWeight <= 0} onclick={() => submit(true)} title={busy ? 'Another scenario is still running' : undefined}>
			<PlayIcon /> Create & start
		</Button>
	</Card.Footer>
</Card.Root>
