<!-- Sub-navigation shown on every /settings page (ADR 0210, 0291). -->
<script lang="ts">
	import SubNav from '$lib/components/app/SubNav.svelte';
	import { isAdmin } from '$lib/components/app/session';
	import { SETTINGS_NAV } from './nav';

	const admin = $derived(isAdmin());
	const items = $derived(SETTINGS_NAV.filter((i) => admin || !i.adminOnly).map((i) => ({ ...i, exact: i.href === '/settings' })));
</script>

<SubNav {items} label="Settings" testid="settings-nav" />
