<script lang="ts">
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import { describeError, errorTitle } from './format';

	let {
		error,
		retry,
		title,
		class: className = ''
	}: { error: unknown; retry?: () => void; title?: string; class?: string } = $props();

	const info = $derived(describeError(error));
</script>

<Alert.Root variant="destructive" class={className}>
	<CircleAlertIcon />
	<Alert.Title>
		{title ?? errorTitle(info.status)}{#if info.status}<span class="ml-1 font-normal opacity-70">({info.status})</span>{/if}
	</Alert.Title>
	<Alert.Description>
		<p class="break-words">{info.message}</p>
		{#if retry}
			<Button variant="outline" size="xs" class="mt-2" onclick={retry}>
				<RotateCcwIcon /> Try again
			</Button>
		{/if}
	</Alert.Description>
</Alert.Root>
