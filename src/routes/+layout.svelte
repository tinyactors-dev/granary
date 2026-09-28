<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import AppShell from '$lib/components/app/AppShell.svelte';
	import SignInLanding from '$lib/components/app/SignInLanding.svelte';
	import OpsBanner from '$lib/components/ops/OpsBanner.svelte';
	import SetupBanner from '$lib/components/settings/SetupBanner.svelte';
	import { isAdminPath } from '$lib/schemas/admin';

	let { data, children } = $props();

	const path: string = $derived(page.url.pathname);
	/** In development mode the admin section is where you sign in, so it never needs a user (ADR 0290). */
	const showApp = $derived(data.user !== null || (isAdminPath(path) && data.devMode) || page.error !== null);
	/** One-time sign-in links (ADR 0161) render their own confirm page for anonymous visitors. */
	const isLoginLink = $derived(path.startsWith('/auth/link/'));
	/**
	 * Banners (ADR 0291): at most one per page. The setup banner while GitHub
	 * isn't connected (not on /settings, which shows the checklist, nor /admin);
	 * otherwise "While you were away" on the Overview only, and only when
	 * something needs attention (/ops says the same in its hero).
	 */
	const banner = $derived.by<'setup' | 'ops' | null>(() => {
		if (!data.user || isAdminPath(path)) return null;
		if (data.setupState === 'needs-github') return path.startsWith('/settings') ? null : 'setup';
		return path === '/' ? 'ops' : null;
	});
</script>

<ModeWatcher />
<Toaster richColors closeButton />
<Tooltip.Provider delayDuration={200}>
	{#if showApp}
		<AppShell>
			{#if banner === 'setup'}<SetupBanner />{:else if banner === 'ops'}<OpsBanner />{/if}
			{@render children()}
		</AppShell>
	{:else if isLoginLink}
		{@render children()}
	{:else}
		<SignInLanding />
	{/if}
</Tooltip.Provider>
