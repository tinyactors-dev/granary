<!-- A persona's leaf state: live (pulsing) or final (double border). -->
<script lang="ts">
	let {
		activeStates,
		finalState,
		finished,
		live
	}: { activeStates: string[]; finalState: string | null; finished: boolean; live: boolean } = $props();
	const label = $derived(finished ? (finalState ?? 'finished') : (activeStates.at(-1) ?? '…'));
	const stopped = $derived(finished && (finalState ?? '').startsWith('(stopped'));
</script>

<span
	data-testid="persona-state"
	class="inline-flex h-5 items-center gap-1.5 rounded-full border px-2 font-mono text-xs whitespace-nowrap {finished
		? stopped
			? 'border-dashed text-muted-foreground'
			: 'border-double border-[3px] text-foreground/80'
		: 'border-primary/40 bg-primary/5 text-foreground'}"
	title={finished ? 'final state' : live ? 'current state (live)' : 'last known state'}
>
	{#if !finished}
		<span class="relative flex size-1.5">
			{#if live}<span class="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-60"></span>{/if}
			<span class="bg-primary relative inline-flex size-1.5 rounded-full"></span>
		</span>
	{/if}
	{label}
</span>
