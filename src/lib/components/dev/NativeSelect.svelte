<!-- A native <select> styled like shadcn inputs; works with remote form fields (`.as('select')`). -->
<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils';

	let { class: className = '', children, value = $bindable(), ...rest }: HTMLSelectAttributes = $props();
</script>

<select
	bind:value
	class={cn(
		'border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive h-9 w-full min-w-0 rounded-md border bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:ring-3 disabled:opacity-50',
		className
	)}
	{...rest}
>
	{@render children?.()}
</select>
