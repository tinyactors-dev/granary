<!--
  Generic component preview (ADR 0077): stories on the left, a clean canvas
  (theme + viewport presets), controls on the right, docs below.
-->
<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import { findPreview } from '$lib/dev-ui/registry';
	import Controls from '$lib/dev-ui/Controls.svelte';
	import type { Args } from '$lib/dev-ui/types';

	let { data } = $props();

	const entry = $derived(findPreview(data.componentId)!);
	const story = $derived(entry.stories.find((s) => s.id === data.storyId)!);

	let args = $state<Args>({});
	$effect(() => {
		args = structuredClone($state.snapshot(story.args));
	});

	type Theme = 'app' | 'light' | 'dark';
	let theme = $state<Theme>('app');
	const WIDTHS = [
		{ id: 'fill', label: 'Fill', px: null },
		{ id: 'desktop', label: '1280', px: 1280 },
		{ id: 'tablet', label: '768', px: 768 },
		{ id: 'phone', label: '375', px: 375 }
	] as const;
	let width = $state<(typeof WIDTHS)[number]['id']>('fill');
	const widthPx = $derived(WIDTHS.find((w) => w.id === width)?.px ?? null);

	const Preview = $derived(entry.preview);
	const Docs = $derived(entry.docs);
</script>

<svelte:head><title>{entry.title} · {story.title} · UI · granary dev</title></svelte:head>

<div class="space-y-4" data-testid="ui-preview" data-component={entry.id} data-story={story.id}>
	<header>
		<div class="text-muted-foreground text-xs"><a class="hover:underline" href="/admin/ui">UI</a> / {entry.title}</div>
		<h1 class="text-xl font-semibold tracking-tight">{entry.title} <span class="text-muted-foreground font-normal">— {story.title}</span></h1>
		<p class="text-muted-foreground text-sm">{story.description ?? entry.description}</p>
	</header>

	<div class="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)_16rem]">
		<nav aria-label="Stories" class="space-y-0.5 text-sm">
			<div class="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">Stories</div>
			{#each entry.stories as s (s.id)}
				<a
					href="/admin/ui/{entry.id}/{s.id}"
					aria-current={s.id === story.id ? 'page' : undefined}
					data-sveltekit-noscroll
					class="block rounded-md px-2 py-1.5 {s.id === story.id ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}"
				>{s.title}</a>
			{/each}
		</nav>

		<div class="min-w-0 space-y-2">
			<div class="flex flex-wrap items-center gap-2 text-xs">
				<div class="flex rounded-md border p-0.5" role="group" aria-label="Canvas theme">
					{#each [{ id: 'app', icon: MonitorIcon, label: 'App theme' }, { id: 'light', icon: SunIcon, label: 'Light' }, { id: 'dark', icon: MoonIcon, label: 'Dark' }] as t (t.id)}
						<button type="button" title={t.label} aria-pressed={theme === t.id} onclick={() => (theme = t.id as Theme)} class="rounded px-1.5 py-1 {theme === t.id ? 'bg-muted' : 'text-muted-foreground'}"><t.icon class="size-3.5" /></button>
					{/each}
				</div>
				<div class="flex rounded-md border p-0.5" role="group" aria-label="Viewport width">
					{#each WIDTHS as w (w.id)}
						<button type="button" aria-pressed={width === w.id} onclick={() => (width = w.id)} class="rounded px-2 py-0.5 {width === w.id ? 'bg-muted' : 'text-muted-foreground'}">{w.label}</button>
					{/each}
				</div>
				<button type="button" class="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1" onclick={() => (args = structuredClone($state.snapshot(story.args)))}>
					<RotateCcwIcon class="size-3.5" /> reset args
				</button>
			</div>
			<div class="overflow-x-auto rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
				<div
					data-testid="ui-canvas"
					class="{theme === 'dark' ? 'dark' : theme === 'light' ? 'theme-light' : ''} bg-background text-foreground mx-auto min-h-48 {entry.canvas?.padded === false ? '' : 'p-6'}"
					style:width={widthPx ? `${widthPx}px` : '100%'}
					style:min-height={entry.canvas?.minHeight}
				>
					{#key story.id}
						<Preview {args} setArgs={(patch: Args) => (args = { ...args, ...patch })} />
					{/key}
				</div>
			</div>
		</div>

		<aside class="space-y-2" aria-label="Story controls">
			<div class="text-muted-foreground text-xs font-medium tracking-wide uppercase">Controls</div>
			<div class="rounded-lg border p-3"><Controls controls={entry.controls} bind:args /></div>
		</aside>
	</div>

	<section class="space-y-2 border-t pt-4">
		<div class="text-muted-foreground flex items-baseline gap-2 text-xs font-medium tracking-wide uppercase">Docs <span class="font-mono font-normal normal-case">{entry.source}</span></div>
		{#if Docs}<Docs {args} />{:else}<p class="text-muted-foreground text-sm">{entry.description}</p>{/if}
	</section>
</div>
