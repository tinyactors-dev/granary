<!--
	First-run banner (ADR 0161, 0210): while GitHub is not connected, admins are
	pointed at the setup wizard; everyone else learns granary is being set up.
	Hidden on the wizard itself and when there is no signed-in user/backend.
-->
<script lang="ts">
	import { page } from '$app/state';
	import SproutIcon from '@lucide/svelte/icons/sprout';
	import { Button } from '$lib/components/ui/button/index.js';
	import { getSetupStatus } from '$lib/remote/settings.remote';
	import { isAdmin } from '$lib/components/app/session';

	const status = getSetupStatus();
	const admin = $derived(isAdmin());
	const onWizard = $derived(page.url.pathname.startsWith('/settings/github'));
</script>

<svelte:boundary>
	{@const s = await status}
	{#if s?.state === 'needs-github' && !onWizard}
		<aside
			class="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-600/20 bg-emerald-600/[0.06] px-4 py-3 text-sm dark:border-emerald-400/20 dark:bg-emerald-400/[0.07]"
			data-testid="setup-banner"
			aria-label="Setup"
		>
			<SproutIcon class="size-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
			<div class="min-w-0 flex-1">
				{#if admin}
					<p class="font-medium">One step left: connect granary to GitHub</p>
					<p class="text-muted-foreground">Until then, webhooks are refused and no issues are checked.</p>
				{:else}
					<p class="font-medium">granary is being set up</p>
					<p class="text-muted-foreground">An admin still needs to connect it to GitHub.</p>
				{/if}
			</div>
			{#if admin}<Button href="/settings/github" size="sm">Connect GitHub</Button>{/if}
		</aside>
	{/if}
	{#snippet pending()}{/snippet}
	{#snippet failed()}{/snippet}
</svelte:boundary>
