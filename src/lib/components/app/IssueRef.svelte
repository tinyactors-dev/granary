<script lang="ts">
	import type { IssueSummary } from '$lib/schemas/api';
	import { issueHref, issueLabel } from './format';

	let {
		issueKey,
		issue,
		showTitle = true
	}: { issueKey: string | null; issue: IssueSummary | null; showTitle?: boolean } = $props();
</script>

{#if issueKey}
	<a href={issueHref(issueKey)} class="group block min-w-0">
		<span class="font-medium underline-offset-4 group-hover:underline"
			>{issue ? issueLabel(issue) : issueKey}</span
		>
		{#if showTitle && issue}
			<span class="text-muted-foreground block max-w-[28rem] truncate text-xs">{issue.title}</span>
		{/if}
	</a>
{:else}
	<span class="text-muted-foreground">—</span>
{/if}
