<!-- Sub-navigation shown on every /ops page (ADR 0141, 0291). -->
<script lang="ts">
	import SubNav from '$lib/components/app/SubNav.svelte';
	import { OPS_NAV } from './nav';

	const items = OPS_NAV.map((i) => ({ ...i, exact: i.href === '/ops' }));
</script>

<SubNav {items} label="Ops" testid="ops-nav" />
