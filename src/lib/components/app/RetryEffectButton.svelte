<!--
	Admin "Retry" for a dead outbox row: `retryEffect(...).updates(...)` so the
	visible listEffects / getIssue queries are refreshed in the same response
	(single-flight mutation, ADR 0031/0051).
-->
<script lang="ts">
	import type { RemoteQueryUpdate } from '@sveltejs/kit';
	import { Button } from '$lib/components/ui/button/index.js';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import { toast } from 'svelte-sonner';
	import { retryEffect } from '$lib/remote/effects.remote';
	import AdminOnly from './AdminOnly.svelte';
	import { describeError } from './format';

	let {
		effectKey,
		updates,
		size = 'xs'
	}: { effectKey: string; updates: () => RemoteQueryUpdate[]; size?: 'xs' | 'sm' } = $props();
	let busy = $state(false);

	async function retry() {
		busy = true;
		try {
			const effect = await retryEffect({ effectKey }).updates(...updates());
			toast.success(`Retrying ${effect.effectKey}`, { description: `State is now ${effect.state}.` });
		} catch (e) {
			toast.error('Retry failed', { description: describeError(e).message });
		} finally {
			busy = false;
		}
	}
</script>

<AdminOnly reason="Only admins can retry GitHub actions">
	{#snippet children({ disabled })}
		<Button variant="outline" {size} disabled={disabled || busy} onclick={retry}>
			<RotateCcwIcon class={busy ? 'animate-spin' : ''} /> Retry
		</Button>
	{/snippet}
</AdminOnly>
