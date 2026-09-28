<!--
	App shell (ADR 0050): fixed sidebar on large screens, a top bar with a
	horizontally scrolling nav on small screens, user menu top right.
	Under /__dev the sidebar switches to the dev portal's areas, with a
	"Back to app" link (ADR 0076).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { NAV, isActive } from './nav';
	import { DEV_GROUPS, DEV_NAV, devActive, isDevPath } from '$lib/components/dev/nav';
	import UserMenu from './UserMenu.svelte';
	import DevTools from '$lib/components/dev/DevTools.svelte';
	import ModeToggle from './ModeToggle.svelte';
	import { shellData } from './session';

	let { children }: { children: Snippet } = $props();

	const data = $derived(shellData());
	const items = $derived(NAV.filter((n) => !n.devOnly || data.devMode));
	const inDev = $derived(data.devMode && isDevPath(page.url.pathname));
	const devCurrent = $derived(DEV_NAV.find((n) => devActive(page.url.pathname, n)));
	const current = $derived(
		inDev
			? devCurrent
				? { label: `Dev · ${devCurrent.label}`, description: devCurrent.description }
				: { label: 'Dev', description: 'Developer console' }
			: items.find((n) => isActive(page.url.pathname, n.href))
	);
</script>

<div class="bg-background flex min-h-svh">
	<aside class="bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 border-r lg:block">
		<div class="sticky top-0 flex h-svh flex-col">
		<a href="/" class="flex h-14 items-center gap-2 border-b px-4 font-semibold">
			<img src="/brand/granary.svg" alt="" class="size-7 rounded-[22%] dark:ring-1 dark:ring-white/10" width="28" height="28" />
			granary
		</a>
		{#if inDev}
		<nav class="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Developer console" data-testid="dev-sidebar">
			<a href="/" class="text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground mb-2 flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium" data-testid="back-to-app">
				<ArrowLeftIcon class="size-4" /> Back to app
			</a>
			{#each DEV_GROUPS as group (group)}
				<div class="text-sidebar-foreground/50 mt-2 px-2.5 pb-1 text-[11px] font-semibold tracking-wide uppercase">{group}</div>
				{#each DEV_NAV.filter((i) => i.group === group) as item (item.href)}
					{@const active = devActive(page.url.pathname, item) && !(item.children ?? []).some((c) => devActive(page.url.pathname, c))}
					<a
						href={item.href}
						aria-current={active ? 'page' : undefined}
						class={cn(
							'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
							active
								? 'bg-sidebar-accent text-sidebar-accent-foreground'
								: 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
						)}
					>
						<item.icon class="size-4" />
						<span class="flex-1">{item.label}</span>
					</a>
					{#each item.children ?? [] as child (child.href)}
						{@const childActive = devActive(page.url.pathname, child)}
						<a
							href={child.href}
							aria-current={childActive ? 'page' : undefined}
							class={cn(
								'ml-6 flex items-center rounded-md border-l px-2.5 py-1 text-sm transition-colors',
								childActive
									? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
									: 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
							)}
						>{child.label}</a>
					{/each}
				{/each}
			{/each}
			<div class="text-sidebar-foreground/50 mt-2 px-2.5 pb-1 text-[11px] font-semibold tracking-wide uppercase">External</div>
			<DevTools compact />
		</nav>
		{:else}
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
		{/if}
		</div>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<header class="bg-background/85 sticky top-0 z-20 border-b backdrop-blur">
			<div class="flex h-14 items-center gap-3 px-4 lg:px-6">
				<a href="/" class="flex items-center gap-2 font-semibold lg:hidden">
					<img src="/brand/granary.svg" alt="" class="size-7 rounded-[22%] dark:ring-1 dark:ring-white/10" width="28" height="28" />
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
				{#if inDev}
					<a href="/" class="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium"><ArrowLeftIcon class="size-4" />App</a>
				{/if}
				{#each inDev ? DEV_NAV : items as item (item.href)}
					{@const active = inDev ? devActive(page.url.pathname, item) : isActive(page.url.pathname, item.href)}
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
