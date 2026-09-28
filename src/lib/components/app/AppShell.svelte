<!--
	App shell (ADR 0050, 0291): fixed sidebar on large screens, a top bar with a
	menu button opening a navigation drawer on small screens (ADR 0296), user menu top right. Under
	/admin the sidebar switches to the admin section's areas, with a "Back to
	app" link (ADR 0290). The top bar names the section only; each page's
	PageHeader carries its title and description.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { NAV, isActive } from './nav';
	import { ADMIN_GROUPS, ADMIN_NAV, adminActive, adminAvailable } from '$lib/components/admin/nav';
	import { isAdminPath } from '$lib/schemas/admin';
	import UserMenu from './UserMenu.svelte';
	import DevTools from '$lib/components/dev/DevTools.svelte';
	import ModeToggle from './ModeToggle.svelte';
	import MobileNav from './MobileNav.svelte';
	import { canSeeAdmin, shellData } from './session';

	let { children }: { children: Snippet } = $props();

	const data = $derived(shellData());
	const admin = $derived(canSeeAdmin(data));
	const items = $derived(NAV.filter((n) => !n.adminOnly || admin));
	const inAdmin = $derived(admin && isAdminPath(page.url.pathname));
	const adminCurrent = $derived(ADMIN_NAV.findLast((n) => adminActive(page.url.pathname, n)));
	const section = $derived(
		inAdmin ? (adminCurrent && adminCurrent.href !== '/admin' ? `Admin · ${adminCurrent.label}` : 'Admin') : items.find((n) => isActive(page.url.pathname, n.href))?.label
	);
</script>

<a
	href="#main"
	class="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
	data-testid="skip-to-content">Skip to content</a
>
<div class="bg-background flex min-h-svh">
	<aside class="bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 border-r lg:block">
		<div class="sticky top-0 flex h-svh flex-col">
		<a href="/" class="flex h-14 items-center gap-2 border-b px-4 font-semibold">
			<img src="/brand/granary.svg" alt="" class="size-7 rounded-[22%] dark:ring-1 dark:ring-white/10" width="28" height="28" />
			granary
		</a>
		{#if inAdmin}
		<nav class="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Admin" data-testid="admin-sidebar">
			<a href="/" class="text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground mb-2 flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium" data-testid="back-to-app">
				<ArrowLeftIcon class="size-4" /> Back to app
			</a>
			{#each ADMIN_GROUPS as group (group)}
				<div class="text-sidebar-foreground/50 mt-2 px-2.5 pb-1 text-[11px] font-semibold tracking-wide uppercase">{group}</div>
				{#each ADMIN_NAV.filter((i) => i.group === group) as item (item.href)}
					{@const active = adminActive(page.url.pathname, item) && !(item.children ?? []).some((c) => adminActive(page.url.pathname, c))}
					{@const available = adminAvailable(item, data.admin)}
					<a
						href={item.href}
						aria-current={active ? 'page' : undefined}
						title={available ? item.description : `${item.description} — not available here`}
						class={cn(
							'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
							active
								? 'bg-sidebar-accent text-sidebar-accent-foreground'
								: 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
							!available && !active && 'text-sidebar-foreground/45'
						)}
					>
						<item.icon class="size-4" />
						<span class="flex-1">{item.label}</span>
						{#if !available}<span class="text-sidebar-foreground/45 text-[10px] font-semibold tracking-wide uppercase">off</span>{/if}
					</a>
					{#each item.children ?? [] as child (child.href)}
						{@const childActive = adminActive(page.url.pathname, child)}
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
						item.adminOnly && 'mt-auto'
					)}
				>
					<item.icon class="size-4" />
					<span class="flex-1">{item.label}</span>
				</a>
			{/each}
		</nav>
		{/if}
		</div>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<header class="bg-background/85 sticky top-0 z-20 border-b backdrop-blur">
			<div class="flex h-14 items-center gap-3 px-4 lg:px-6">
				<MobileNav {items} {inAdmin} {data} />
				<a href="/" class="flex shrink-0 items-center gap-2 font-semibold lg:hidden" aria-label="granary home">
					<img src="/brand/granary.svg" alt="" class="size-7 rounded-[22%] dark:ring-1 dark:ring-white/10" width="28" height="28" />
				</a>
				{#if section}<div class="text-foreground lg:text-muted-foreground min-w-0 truncate text-sm font-medium" data-testid="topbar-section">{section}</div>{/if}
				<div class="ml-auto flex shrink-0 items-center gap-1">
					<ModeToggle />
					<UserMenu />
				</div>
			</div>
		</header>
		<main id="main" tabindex="-1" class="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 focus:outline-none lg:px-8">
			{@render children()}
		</main>
	</div>
</div>
