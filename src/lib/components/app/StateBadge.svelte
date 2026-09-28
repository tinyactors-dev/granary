<script lang="ts">
	import { cn } from '$lib/utils';
	import { toneOf, type Tone } from './format';
	import { stateLabel } from './glossary';

	let { state, tone, label, class: className = '' }: { state: string; tone?: Tone; label?: string; class?: string } = $props();

	const TONE_CLASS: Record<Tone, string> = {
		success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
		warning: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
		danger: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
		info: 'bg-sky-500/12 text-sky-700 dark:text-sky-400 border-sky-500/25',
		muted: 'bg-muted text-muted-foreground border-border'
	};
	const resolved = $derived(tone ?? toneOf(state));
</script>

<span
	data-state={state}
	class={cn(
		'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap',
		TONE_CLASS[resolved],
		className
	)}
>
	<span class="size-1.5 rounded-full bg-current opacity-80"></span>
	{label ?? stateLabel(state)}
</span>
