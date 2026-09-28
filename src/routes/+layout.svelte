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

	let { data, children } = $props();

	/** `/__dev` is where you sign in during development, so it never needs a user. */
	const path: string = $derived(page.url.pathname);
	const isDevRoute = $derived(path === '/__dev' || path.startsWith('/__dev/'));
	/** In dev mode the actor inspector (ADR 0056) is reachable from /__dev without signing in. */
	const isInspector = $derived(path.startsWith('/actors/'));
	const showApp = $derived(data.user !== null || ((isDevRoute || isInspector) && data.devMode) || page.error !== null);
	/** One-time sign-in links (ADR 0161) render their own confirm page for anonymous visitors. */
	const isLoginLink = $derived(path.startsWith('/auth/link/'));
</script>

<ModeWatcher />
<Toaster richColors closeButton />
<Tooltip.Provider delayDuration={200}>
	{#if showApp}
		<AppShell>
			<!-- "While you were away" (ADR 0100, 0104): signed-in users, outside the dev portal. -->
			<!-- First run (ADR 0161, 0210): until GitHub is connected. -->
			{#if data.user && !isDevRoute}<SetupBanner />{/if}
			{#if data.user && !isDevRoute}<OpsBanner />{/if}
			{@render children()}
		</AppShell>
	{:else if isLoginLink}
		{@render children()}
	{:else}
		<SignInLanding />
	{/if}
</Tooltip.Provider>
