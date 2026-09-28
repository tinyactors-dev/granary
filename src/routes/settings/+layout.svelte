<script lang="ts">
	import SettingsNav from '$lib/components/settings/SettingsNav.svelte';

	let { children } = $props();
</script>

<SettingsNav />
{@render children()}
