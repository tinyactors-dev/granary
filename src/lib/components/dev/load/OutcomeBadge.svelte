<script lang="ts">
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	let { outcome }: { outcome: 'as-expected' | 'pending' | 'violation' } = $props();
</script>

<StateBadge
	state={outcome === 'as-expected' ? 'as expected' : outcome}
	tone={outcome === 'as-expected' ? 'success' : outcome === 'violation' ? 'danger' : 'warning'}
/>
