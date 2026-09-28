<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<!-- A heading for assistive technology: cards are h2-level sections under the page's h1
     (granary design audit: h3s inside cards skipped a level). Override with aria-level. -->
<div
	bind:this={ref}
	data-slot="card-title"
	role="heading"
	aria-level={2}
	class={cn("text-base leading-normal font-medium group-data-[size=sm]/card:text-sm", className)}
	{...restProps}
>
	{@render children?.()}
</div>
