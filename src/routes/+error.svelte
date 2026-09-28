<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { errorTitle } from '$lib/components/app/format';
</script>

<svelte:head>
	<title>{page.status} · granary</title>
</svelte:head>

<div class="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
	<CircleAlertIcon class="text-muted-foreground size-10" />
	<h1 class="text-2xl font-semibold">{page.status} — {errorTitle(page.status)}</h1>
	<p class="text-muted-foreground">{page.error?.message ?? 'Unexpected error'}</p>
	<Button href="/" variant="outline">Back to overview</Button>
</div>
