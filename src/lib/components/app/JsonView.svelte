<script lang="ts">
	import { cn } from '$lib/utils';
	import { prettyJson } from './format';

	let { value, class: className = '' }: { value: unknown; class?: string } = $props();
</script>

<pre
	class={cn(
		'bg-muted/60 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed',
		className
	)}>{prettyJson(value)}</pre>
