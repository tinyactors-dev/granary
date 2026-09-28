<!-- Personas of one scenario grouped by kind; polls while the scenario is live. -->
<script lang="ts">
	import { listPersonas } from '$lib/remote/load.remote';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { PERSONA_KINDS, type PersonaKind } from '$lib/schemas/dev';
	import PersonaCard from './PersonaCard.svelte';
	import KindIcon from './KindIcon.svelte';
	import { KIND_LABEL } from './meta';

	let { scenarioId, kind = null, live }: { scenarioId: string; kind?: PersonaKind | null; live: boolean } = $props();

	const personas = $derived(listPersonas({ scenarioId, ...(kind ? { kind } : {}) }));

	$effect(() => {
		if (!live) return;
		const q = personas;
		const t = setInterval(() => void q.refresh(), 2000);
		return () => clearInterval(t);
	});
</script>

<svelte:boundary>
	{@const ps = await personas}
	<div class="space-y-6">
		{#each PERSONA_KINDS.filter((k) => ps.some((p) => p.kind === k)) as k (k)}
			{@const group = ps.filter((p) => p.kind === k)}
			<section>
				<h2 class="mb-2 flex items-center gap-2 text-sm font-medium">
					<KindIcon kind={k} class="size-4" />{KIND_LABEL[k]}
					<span class="text-muted-foreground font-normal">{group.length} · {group.filter((p) => !p.finished).length} active</span>
				</h2>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
					{#each group as p (p.id)}<PersonaCard {p} />{/each}
				</div>
			</section>
		{:else}
			<p class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
				No personas{kind ? ` of kind ${kind}` : ''} have arrived yet.
			</p>
		{/each}
	</div>
	{#snippet failed(error, reset)}<ErrorAlert {error} retry={() => { void personas.refresh(); reset(); }} />{/snippet}
</svelte:boundary>
