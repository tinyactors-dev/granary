<script lang="ts">
	import OpsNav from '$lib/components/ops/OpsNav.svelte';

	let { children } = $props();
</script>

<OpsNav />
{@render children()}
