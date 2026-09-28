<!-- A persona's narrated timeline: its own words, actions, results, granary's reactions. -->
<script lang="ts">
	import MessageSquareQuoteIcon from '@lucide/svelte/icons/message-square-quote';
	import SendIcon from '@lucide/svelte/icons/send';
	import CheckIcon from '@lucide/svelte/icons/check';
	import BellIcon from '@lucide/svelte/icons/bell';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Component } from 'svelte';
	import type { TimelineEntry } from '$lib/schemas/dev';
	import { absoluteTime } from '$lib/components/app/format';

	let { entries, issueUrl }: { entries: TimelineEntry[]; issueUrl: (n: number) => string } = $props();

	const KINDS = ['narration', 'action', 'result', 'notification', 'error'] as const;
	const META: Record<TimelineEntry['kind'], { icon: Component; label: string; cls: string }> = {
		narration: { icon: MessageSquareQuoteIcon, label: 'thinks', cls: 'text-foreground' },
		action: { icon: SendIcon, label: 'does', cls: 'text-foreground' },
		result: { icon: CheckIcon, label: 'result', cls: 'text-muted-foreground' },
		notification: { icon: BellIcon, label: 'granary / others', cls: 'text-sky-700 dark:text-sky-300' },
		error: { icon: TriangleAlertIcon, label: 'error', cls: 'text-amber-700 dark:text-amber-400' }
	};
	let shown = $state<Record<string, boolean>>({ narration: true, action: true, result: true, notification: true, error: true });
	const visible = $derived(entries.filter((e) => shown[e.kind]));
	const t0 = $derived(entries.at(-1)?.at ?? 0);
	const rel = (at: number) => `+${((at - t0) / 1000).toFixed(1)}s`;
</script>

<div class="mb-2 flex flex-wrap gap-1.5 text-xs">
	{#each KINDS as k (k)}
		{@const M = META[k]}
		<button
			type="button"
			aria-pressed={shown[k]}
			onclick={() => (shown[k] = !shown[k])}
			class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 {shown[k] ? 'bg-muted' : 'text-muted-foreground opacity-60'}"
		>
			<M.icon class="size-3" />{M.label}
		</button>
	{/each}
</div>
<ol class="relative space-y-2 border-l pl-4" data-testid="persona-timeline">
	{#each visible as e, i (i)}
		{@const M = META[e.kind]}
		<li class="relative">
			<span class="bg-background absolute top-0.5 -left-[1.4rem] rounded-full border p-0.5"><M.icon class="size-3 {M.cls}" /></span>
			<div class="flex flex-wrap items-baseline gap-x-2">
				<time class="text-muted-foreground font-mono text-[11px] tabular-nums" title={absoluteTime(e.at)}>{rel(e.at)}</time>
				{#if e.state}<span class="bg-muted rounded px-1 font-mono text-[11px]">{e.state}</span>{/if}
				{#if e.issueNumber !== null}<a class="text-muted-foreground font-mono text-[11px] underline-offset-2 hover:underline" href={issueUrl(e.issueNumber)} target="_blank" rel="noreferrer">#{e.issueNumber}</a>{/if}
			</div>
			<p class="text-sm {M.cls} {e.kind === 'narration' ? 'italic' : ''}">{e.text}</p>
		</li>
	{:else}
		<li class="text-muted-foreground text-sm">Nothing yet.</li>
	{/each}
</ol>
