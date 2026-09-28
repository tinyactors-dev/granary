<!--
	App shell (ADR 0050): fixed sidebar on large screens, a top bar with a
	horizontally scrolling nav on small screens, user menu top right.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import WheatIcon from '@lucide/svelte/icons/wheat';
	import { NAV, isActive } from './nav';
	import UserMenu from './UserMenu.svelte';
	import ModeToggle from './ModeToggle.svelte';
	import { shellData } from './session';

	let { children }: { children: Snippet } = $props();

	const data = $derived(shellData());
	const items = $derived(NAV.filter((n) => !n.devOnly || data.devMode));
	const current = $derived(items.find((n) => isActive(page.url.pathname, n.href)));
</script>

<div class="bg-background flex min-h-svh">
	<aside class="bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 border-r lg:block">
		<div class="sticky top-0 flex h-svh flex-col">
		<a href="/" class="flex h-14 items-center gap-2 border-b px-4 font-semibold">
			<span class="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
				<WheatIcon class="size-4" />
			</span>
			granary
		</a>
		<nav class="flex flex-1 flex-col gap-0.5 p-2" aria-label="Main">
			{#each items as item (item.href)}
				{@const active = isActive(page.url.pathname, item.href)}
				<a
					href={item.href}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
						active
							? 'bg-sidebar-accent text-sidebar-accent-foreground'
							: 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
						item.devOnly && 'mt-auto'
					)}
				>
					<item.icon class="size-4" />
					<span class="flex-1">{item.label}</span>
					{#if item.devOnly}
						<span class="rounded bg-amber-500/15 px-1.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400">dev</span>
					{/if}
				</a>
			{/each}
		</nav>
		</div>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<header class="bg-background/85 sticky top-0 z-20 border-b backdrop-blur">
			<div class="flex h-14 items-center gap-3 px-4 lg:px-6">
				<a href="/" class="flex items-center gap-2 font-semibold lg:hidden">
					<span class="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
						<WheatIcon class="size-4" />
					</span>
					<span class="hidden sm:inline">granary</span>
				</a>
				<div class="text-muted-foreground hidden min-w-0 text-sm lg:block">
					{#if current}<span class="text-foreground font-medium">{current.label}</span>
						<span class="mx-1.5">·</span>{current.description}{/if}
				</div>
				<div class="ml-auto flex items-center gap-1">
					<ModeToggle />
					<UserMenu />
				</div>
			</div>
			<nav class="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden" aria-label="Main (mobile)">
				{#each items as item (item.href)}
					{@const active = isActive(page.url.pathname, item.href)}
					<a
						href={item.href}
						aria-current={active ? 'page' : undefined}
						class={cn(
							'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium',
							active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
						)}
					>
						<item.icon class="size-4" />{item.label}
					</a>
				{/each}
			</nav>
		</header>
		<main class="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 lg:px-8">
			{@render children()}
		</main>
	</div>
</div>
