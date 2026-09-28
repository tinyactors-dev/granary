<!-- A link to a tool outside granary (Grafana, a storage console; ADR 0154). Opens in a new tab. -->
<script lang="ts">
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	let { href, label, class: cls = '' }: { href: string; label: string; class?: string } = $props();
</script>

<a class="inline-flex items-center gap-1 underline-offset-4 hover:underline {cls}" {href} target="_blank" rel="noreferrer" data-testid="external-link">
	{label} <ExternalLinkIcon class="size-3.5" />
</a>
