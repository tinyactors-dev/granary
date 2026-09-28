<script lang="ts">
	import type { RemoteFormIssue } from '@sveltejs/kit';

	let { issues }: { issues: RemoteFormIssue[] | undefined } = $props();
</script>

{#each issues ?? [] as issue, i (i)}
	<p class="text-destructive text-xs">{issue.message}</p>
{/each}
