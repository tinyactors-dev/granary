<script lang="ts">
	import type { ActorAddress } from '$lib/schemas/actors';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { getDapLaunchConfig } from '$lib/remote/dev.remote';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';

	let { address }: { address: ActorAddress } = $props();
	const config = $derived(getDapLaunchConfig({ address }));
</script>

<svelte:boundary>
	{@const c = await config}
	{@const text = JSON.stringify({ version: '0.2.0', configurations: [c] }, null, 2)}
	<div class="relative">
		<div class="absolute top-2 right-2"><CopyButton {text} label="Copy launch.json" /></div>
		<pre class="bg-muted/60 overflow-auto rounded-md border p-3 pr-32 font-mono text-xs leading-relaxed" data-testid="launch-json">{text}</pre>
	</div>
	{#snippet pending()}<Skeleton class="h-32 w-full" />{/snippet}
	{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
</svelte:boundary>
