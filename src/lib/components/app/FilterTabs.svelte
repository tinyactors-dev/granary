<!--
	State filter rendered as links (`?<param>=<value>`), so it works without
	JavaScript and the filter is part of the URL (ADR 0051).
-->
<script lang="ts">
	import { page } from '$app/state';
	import { cn } from '$lib/utils';
	import { stateLabel } from './glossary';

	let {
		param = 'state',
		values,
		current,
		labels = {},
		allLabel = 'All'
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
	class="bg-muted text-muted-foreground inline-flex w-fit max-w-full flex-wrap items-center gap-y-[3px] rounded-lg p-[3px] sm:h-9 sm:flex-nowrap sm:overflow-x-auto"
>
	{#each options as value (value ?? '')}
		<a
			href={href(value)}
			data-sveltekit-noscroll
			aria-current={current === value ? 'page' : undefined}
			class={cn(
				'inline-flex h-[30px] items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors',
				current === value
					? 'bg-background text-foreground shadow-sm dark:bg-input/30'
					: 'hover:text-foreground'
			)}>{value === null ? allLabel : (labels[value] ?? stateLabel(value))}</a
		>
	{/each}
</nav>
