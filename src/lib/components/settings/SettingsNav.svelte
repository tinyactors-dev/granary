<!-- Horizontal sub-navigation shown on every /settings page (ADR 0210). -->
<script lang="ts">
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import { isAdmin } from '$lib/components/app/session';
	import { SETTINGS_NAV, settingsActive } from './nav';

	const admin = $derived(isAdmin());
</script>

<nav class="-mx-1 flex gap-1 overflow-x-auto border-b pb-2" aria-label="Settings" data-testid="settings-nav">
	{#each SETTINGS_NAV.filter((i) => admin || !i.adminOnly) as item (item.href)}
		{@const active = settingsActive(page.url.pathname, item.href)}
		<a
			href={item.href}
			aria-current={active ? 'page' : undefined}
			class={cn(
				'shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
				active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
			)}>{item.label}</a
		>
	{/each}
</nav>
