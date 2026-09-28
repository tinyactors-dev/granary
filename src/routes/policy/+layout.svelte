<!-- Policy (ADR 0291): who may open issues and pull requests, and what granary says when it closes one. -->
<script lang="ts">
	import SubNav from '$lib/components/app/SubNav.svelte';

	let { children } = $props();
	const items = [
		{ href: '/policy', label: 'Allowlist & blocklist', exact: true },
		{ href: '/policy/closing-message', label: 'Closing message' }
	];
</script>

<SubNav {items} label="Policy" testid="policy-nav" />
{@render children()}
