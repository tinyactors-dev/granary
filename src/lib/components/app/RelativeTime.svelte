<script lang="ts">
	import { absoluteTime, isoTime, relativeTime } from './format';
	import { currentTime } from './clock.svelte';

	let { ms, class: className = '' }: { ms: number | null | undefined; class?: string } = $props();
</script>

{#if ms === null || ms === undefined}
	<span class="text-muted-foreground {className}">—</span>
{:else}
	<time datetime={isoTime(ms)} title={absoluteTime(ms)} class="whitespace-nowrap {className}"
		>{relativeTime(ms, currentTime())}</time
	>
{/if}
