<!-- Empty state for an address with no resident actor (ADR 0056). -->
<script lang="ts">
	import * as Alert from '$lib/components/ui/alert/index.js';
	import GhostIcon from '@lucide/svelte/icons/ghost';
	import { issueHref } from '$lib/components/app/format';

	let { family, name }: { family: string; name: string } = $props();
</script>

<Alert.Root data-testid="actor-gone">
	<GhostIcon />
	<Alert.Title>No resident actor at <span class="font-mono">{family}/{name}</span></Alert.Title>
	<Alert.Description>
		<p>
			It was never loaded, it finished (finished actors are destroyed), or it was unloaded. Inspecting
			never loads an actor.
		</p>
		{#if family === 'issue'}
			<p>
				The issue's deliveries, outbox effect and verdict are kept in the write-ahead log:
				<a class="text-foreground underline underline-offset-4" href={issueHref(name)}>open issue {name}</a>.
			</p>
		{/if}
		<p><a class="text-foreground underline underline-offset-4" href="/actors">Back to resident actors</a></p>
	</Alert.Description>
</Alert.Root>
