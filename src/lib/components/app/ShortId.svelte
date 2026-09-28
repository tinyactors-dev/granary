<!--
	A long identifier (delivery id, run id…) shown short, with the full value in
	the tooltip and an icon button that copies it (ADR 0296): keeps tables from
	overflowing without losing the id.
-->
<script lang="ts">
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { toast } from 'svelte-sonner';
	import { cn } from '$lib/utils';

	let { id, length = 8, label = 'Copy id', class: className }: { id: string; length?: number; label?: string; class?: string } = $props();
	let copied = $state(false);

	async function copy(e: MouseEvent) {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(id);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			toast.error('Could not copy to the clipboard');
		}
	}
</script>

<span class={cn('inline-flex items-center gap-1 font-mono text-xs', className)} title={id}>
	<span>{id.length > length ? id.slice(0, length) + '…' : id}</span>
	<button
		type="button"
		onclick={copy}
		aria-label="{label} {id}"
		class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
	>
		{#if copied}<CheckIcon class="size-3.5" />{:else}<CopyIcon class="size-3.5" />{/if}
	</button>
</span>
