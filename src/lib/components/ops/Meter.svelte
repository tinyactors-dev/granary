<!--
	A value-vs-limit meter (dataviz skill: meter). The fill carries severity
	(accent → warning → over); the track is a lighter step of the same hue.
	Severity is never colour alone: an icon and a word accompany it.
-->
<script lang="ts">
	import { cn } from '$lib/utils';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';

	let {
		label,
		value,
		max,
		format,
		projected,
		warnAt = 0.8,
		note,
		class: className = ''
	}: {
		label: string;
		value: number;
		max: number;
		format: (n: number) => string;
		/** Optional projection (e.g. end-of-month), drawn as a tick. */
		projected?: number | null;
		warnAt?: number;
		note?: string;
		class?: string;
	} = $props();

	const ratio = $derived(max > 0 ? value / max : 0);
	const pRatio = $derived(projected != null && max > 0 ? projected / max : null);
	const worst = $derived(Math.max(ratio, pRatio ?? 0));
	const level = $derived(worst > 1 ? 'over' : worst >= warnAt ? 'warn' : 'ok');
	const FILL = { ok: 'bg-sky-600 dark:bg-sky-400', warn: 'bg-amber-500 dark:bg-amber-400', over: 'bg-red-600 dark:bg-red-400' };
	const TRACK = { ok: 'bg-sky-600/15 dark:bg-sky-400/15', warn: 'bg-amber-500/20 dark:bg-amber-400/15', over: 'bg-red-600/15 dark:bg-red-400/15' };
</script>

<div class={cn('grid gap-1.5', className)} data-testid="meter" data-level={level}>
	<div class="flex items-baseline justify-between gap-3 text-sm">
		<span class="text-muted-foreground">{label}</span>
		<span class="font-medium tabular-nums">{format(value)} <span class="text-muted-foreground font-normal">of {format(max)}</span></span>
	</div>
	<div
		class={cn('relative h-2 overflow-hidden rounded-full', TRACK[level])}
		role="meter"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={max}
		aria-valuenow={value}
		aria-valuetext="{format(value)} of {format(max)}"
	>
		<div class={cn('h-full rounded-full transition-[width]', FILL[level])} style="width: {Math.min(100, ratio * 100)}%"></div>
		{#if pRatio !== null}
			<div
				class="bg-foreground/70 absolute top-0 h-full w-0.5"
				style="left: calc({Math.min(100, pRatio * 100)}% - 1px)"
				title="Projected: {format(projected ?? 0)}"
			></div>
		{/if}
	</div>
	<div class="text-muted-foreground flex items-center gap-1.5 text-xs">
		{#if level === 'over'}
			<CircleAlertIcon class="size-3.5 text-red-600 dark:text-red-400" /><span class="text-foreground font-medium">Over the limit.</span>
		{:else if level === 'warn'}
			<TriangleAlertIcon class="size-3.5 text-amber-600 dark:text-amber-400" /><span class="text-foreground font-medium">Close to the limit.</span>
		{/if}
		{#if projected != null}<span>Projected {format(projected)}.</span>{/if}
		{#if note}<span>{note}</span>{/if}
	</div>
</div>
