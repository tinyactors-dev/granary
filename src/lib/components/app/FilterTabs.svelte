<!--
	State filter rendered as links (`?<param>=<value>`), so it works without
	JavaScript and the filter is part of the URL (ADR 0051).
-->
<script lang="ts">
	import { page } from '$app/state';
	import { cn } from '$lib/utils';

	let {
		param = 'state',
		values,
		current,
		labels = {},
		allLabel = 'all'
	}: { param?: string; values: readonly string[]; current: string | null; labels?: Record<string, string>; allLabel?: string } = $props();

	function href(value: string | null) {
		const url = new URL(page.url);
		if (value) url.searchParams.set(param, value);
		else url.searchParams.delete(param);
		return url.pathname + url.search;
	}
	const options = $derived([null, ...values]);
</script>

<nav
	aria-label="Filter"
	class="bg-muted text-muted-foreground inline-flex h-9 w-fit max-w-full items-center overflow-x-auto rounded-lg p-[3px]"
>
	{#each options as value (value ?? '')}
		<a
			href={href(value)}
			data-sveltekit-noscroll
			aria-current={current === value ? 'page' : undefined}
			class={cn(
				'inline-flex h-full items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors',
				current === value
					? 'bg-background text-foreground shadow-sm dark:bg-input/30'
					: 'hover:text-foreground'
			)}>{value === null ? allLabel : (labels[value] ?? value)}</a
		>
	{/each}
</nav>
