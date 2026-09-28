<!--
	Section sub-navigation (ADR 0291): one component for Policy, Ops and
	Settings, so they look and behave the same. `exact` items are active only
	on their own path (the section's first page).
-->
<script lang="ts" module>
	export interface SubNavItem {
		href: string;
		label: string;
		exact?: boolean;
	}
</script>

<script lang="ts">
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import { scrollFade } from './scroll-fade';

	let { items, label, testid }: { items: SubNavItem[]; label: string; testid?: string } = $props();

	const active = (item: SubNavItem, pathname: string) => (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + '/'));
</script>

<nav use:scrollFade class="scroll-fade-x -mx-1 flex gap-1 overflow-x-auto border-b px-1 pb-2" aria-label={label} data-testid={testid}>
	{#each items as item (item.href)}
		{@const isActive = active(item, page.url.pathname)}
		<a
			href={item.href}
			aria-current={isActive ? 'page' : undefined}
			class={cn(
				'shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
				isActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
			)}>{item.label}</a
		>
	{/each}
</nav>
