<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';

	let { data, form } = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Sign in · granary</title></svelte:head>

<main class="bg-background flex min-h-svh items-center justify-center p-4">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<Card.Title>Sign in to granary</Card.Title>
			<Card.Description>
				This one-time link was created with <code>granary login-link</code>. It works once and expires after a short time.
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-4">
			{#if form?.error}
				<Alert.Root variant="destructive" data-testid="login-link-error"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
			{/if}
			{#if data.wellFormed}
				<form
					method="POST"
					use:enhance={() => {
						busy = true;
						return async ({ update }) => {
							await update();
							busy = false;
						};
					}}
				>
					<Button type="submit" class="w-full" disabled={busy} data-testid="login-link-continue">Continue</Button>
				</form>
			{:else}
				<p class="text-muted-foreground text-sm">This sign-in link is not valid.</p>
			{/if}
		</Card.Content>
	</Card.Root>
</main>
