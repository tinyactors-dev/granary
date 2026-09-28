<!--
	Renders an admin-only control. Admins get it enabled; everybody else gets
	it disabled inside a tooltip explaining why (ADR 0050).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { isAdmin } from './session';

	let {
		children,
		reason = 'Only admins can do this'
	}: { children: Snippet<[{ disabled: boolean }]>; reason?: string } = $props();

	const admin = $derived(isAdmin());
</script>

{#if admin}
	{@render children({ disabled: false })}
{:else}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<span {...props} class="inline-flex cursor-not-allowed">
					{@render children({ disabled: true })}
				</span>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{reason}</Tooltip.Content>
	</Tooltip.Root>
{/if}
