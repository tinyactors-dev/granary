<!--
	The admin section (ADR 0290). Areas that aren't available in this
	environment (e.g. a simulation service without its URL, impersonation in
	production) show how to turn them on instead of their page.
-->
<script lang="ts">
	import { page } from '$app/state';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import InfoIcon from '@lucide/svelte/icons/info';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import { shellData } from '$lib/components/app/session';
	import { ADMIN_NAV, adminActive, adminAvailable } from '$lib/components/admin/nav';

	let { children } = $props();

	const HOW: Record<string, string> = {
		impersonate: 'Signing in as someone else only exists in development mode (vite dev or GRANARY_DEV=1). In production, use `granary login-link <login>` on the host.',
		fakeGithub: 'This instance talks to the real GitHub. Simulation runs in the sandbox, a throwaway granary on the fake GitHub next to this one (ADR 0312, 0315).',
		fakeInfra: 'Run fake-infra next to granary (bound to 127.0.0.1) and set FAKE_INFRA_URL.',
		loadgen: 'Run the load generator and the fake GitHub next to granary and set LOADGEN_URL and FAKE_GITHUB_URL. Point them at a sandbox instance of granary, never the production one.'
	};
	/** Areas whose page lives in the sandbox (ADR 0315). */
	const IN_SANDBOX = new Set(['fakeGithub']);

	const item = $derived(ADMIN_NAV.findLast((n) => adminActive(page.url.pathname, n)));
	const blocked = $derived(item && item.capability && !adminAvailable(item, shellData().admin) ? item : null);
</script>

{#if blocked}
	<PageHeader title={blocked.label} description={blocked.description} />
	<Alert.Root data-testid="admin-unavailable">
		<InfoIcon />
		<Alert.Title>Not available here</Alert.Title>
		<Alert.Description>
			{HOW[blocked.capability ?? ''] ?? 'This area is off in this environment.'}
			{#if IN_SANDBOX.has(blocked.capability ?? '')}
				<a href="/admin/sandbox" class="text-foreground mt-1 block font-medium underline underline-offset-4" data-testid="admin-unavailable-sandbox">Open the sandbox →</a>
			{/if}
		</Alert.Description>
	</Alert.Root>
{:else}
	{@render children()}
{/if}
