<!--
	Mobile navigation (ADR 0296): below the lg breakpoint the sidebar becomes a
	drawer behind a menu button, instead of a second horizontally scrolling bar.
	It shows the same entries as the desktop sidebar — the main nav, or under
	/admin the admin areas grouped with a "Back to app" link — and closes when
	you navigate.
-->
<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import XIcon from '@lucide/svelte/icons/x';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { isActive, type NavItem } from './nav';
	import { ADMIN_GROUPS, ADMIN_NAV, adminActive, adminAvailable } from '$lib/components/admin/nav';
	import type { ShellData } from './session';

	let { items, inAdmin, data }: { items: NavItem[]; inAdmin: boolean; data: ShellData } = $props();

	let open = $state(false);
	let lastPath = page.url.pathname;
	$effect(() => {
		const path = page.url.pathname;
		if (path !== lastPath) {
			lastPath = path;
			open = false;
		}
	});

	const link = (active: boolean, dim = false) =>
		cn(
			'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
			active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
			dim && !active && 'opacity-60'
		);
</script>

<DialogPrimitive.Root bind:open>
	<DialogPrimitive.Trigger
		class="hover:bg-muted -ml-1.5 inline-flex size-9 items-center justify-center rounded-md lg:hidden"
		aria-label="Open navigation"
		data-testid="mobile-nav-trigger"
	>
		<MenuIcon class="size-5" />
	</DialogPrimitive.Trigger>
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay class="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/40" />
		<DialogPrimitive.Content
			class="bg-background data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left fixed inset-y-0 left-0 z-50 flex w-[min(20rem,85vw)] flex-col border-r shadow-xl outline-none"
			data-testid="mobile-nav"
		>
			<div class="flex h-14 items-center gap-2 border-b px-4">
				<img src="/brand/granary.svg" alt="" class="size-7 rounded-[22%] dark:ring-1 dark:ring-white/10" width="28" height="28" />
				<DialogPrimitive.Title class="font-semibold">granary</DialogPrimitive.Title>
				<DialogPrimitive.Close class="hover:bg-muted ml-auto inline-flex size-9 items-center justify-center rounded-md" aria-label="Close navigation">
					<XIcon class="size-5" />
				</DialogPrimitive.Close>
			</div>
			<nav class="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label={inAdmin ? 'Admin' : 'Main'}>
				{#if inAdmin}
					<a href="/" class={link(false)}><ArrowLeftIcon class="size-4" /> Back to app</a>
					{#each ADMIN_GROUPS as group (group)}
						<div class="text-muted-foreground/70 mt-3 px-3 pb-1 text-[11px] font-semibold tracking-wide uppercase">{group}</div>
						{#each ADMIN_NAV.filter((i) => i.group === group) as item (item.href)}
							{@const active = adminActive(page.url.pathname, item)}
							{@const available = adminAvailable(item, data.admin)}
							<a href={item.href} aria-current={active ? 'page' : undefined} class={link(active, !available)}>
								<item.icon class="size-4" />
								<span class="flex-1">{item.label}</span>
								{#if !available}<span class="text-[10px] font-semibold tracking-wide uppercase">off</span>{/if}
							</a>
						{/each}
					{/each}
				{:else}
					{#each items as item (item.href)}
						{@const active = isActive(page.url.pathname, item.href)}
						<a href={item.href} aria-current={active ? 'page' : undefined} class={cn(link(active), item.adminOnly && 'mt-3')}>
							<item.icon class="size-4" />
							<span class="flex-1">{item.label}</span>
						</a>
					{/each}
				{/if}
			</nav>
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
</DialogPrimitive.Root>
