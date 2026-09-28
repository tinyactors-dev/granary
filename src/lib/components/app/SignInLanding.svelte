<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import BugIcon from '@lucide/svelte/icons/bug';
	import ModeToggle from './ModeToggle.svelte';
	import { shellData } from './session';

	const devMode = $derived(shellData().devMode);
	const redirect = $derived(page.url.pathname + page.url.search);
	const loginHref = $derived(`/auth/login?redirect=${encodeURIComponent(redirect)}`);
</script>

<svelte:head>
	<title>Sign in · granary</title>
</svelte:head>

<div class="relative flex min-h-svh flex-col items-center justify-center px-4 py-12">
	<div class="absolute top-3 right-3"><ModeToggle /></div>
	<div
		class="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,var(--color-muted),transparent_60%)]"
	></div>
	<Card.Root class="w-full max-w-sm">
		<Card.Header class="items-center text-center">
			<img src="/brand/granary.svg" alt="" class="mx-auto mb-2 size-12 rounded-[22%] dark:ring-1 dark:ring-white/10" width="48" height="48" />
			<Card.Title class="text-xl">Sign in to granary</Card.Title>
			<Card.Description>
				granary closes GitHub issues and pull requests opened by people who are not on the allowlist.
				Sign in to follow its activity and manage the policy.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			<Button href={loginHref} size="lg" class="w-full" data-sveltekit-reload>
				<LogInIcon /> Sign in with GitHub
			</Button>
			{#if devMode}
				<Button href="/admin" variant="outline" size="lg" class="w-full">
					<BugIcon /> Developer console
				</Button>
			{/if}
		</Card.Content>
		<Card.Footer>
			<p class="text-muted-foreground w-full text-center text-xs">Only admins can sign in.</p>
		</Card.Footer>
	</Card.Root>
</div>
