<!-- Horizontal sub-navigation shown on every /ops page (ADR 0141). -->
<script lang="ts">
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import { OPS_NAV, opsActive } from './nav';
</script>

<nav class="-mx-1 flex gap-1 overflow-x-auto border-b pb-2" aria-label="Operations" data-testid="ops-nav">
	{#each OPS_NAV as item (item.href)}
		{@const active = opsActive(page.url.pathname, item.href)}
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
