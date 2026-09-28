<!-- Violations with evidence: persona, issue links, the issue's timeline. -->
<script lang="ts">
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import type { Violation } from '$lib/schemas/dev';
	import { issueHref } from '$lib/components/app/format';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import KindIcon from './KindIcon.svelte';
	import IssueTimeline from './IssueTimeline.svelte';
	import { personaHref } from './meta';

	let { violations }: { violations: Violation[] } = $props();
</script>

{#if violations.length === 0}
	<p class="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">No violations.</p>
{:else}
	<ul class="space-y-2" data-testid="violations">
		{#each violations as v (v.id)}
			<li class="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
				<details>
					<summary class="cursor-pointer list-none">
						<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
							<span class="rounded bg-red-500/15 px-1.5 font-mono text-xs text-red-700 dark:text-red-300">{v.invariant}</span>
							<span class="text-sm">{v.message}</span>
							<RelativeTime ms={v.at} class="text-muted-foreground ml-auto text-xs" />
						</div>
						<div class="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
							{#if v.persona}
								<a href={personaHref(v.persona.kind, v.persona.name)} class="text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline">
									<KindIcon kind={v.persona.kind} class="size-3.5" />{v.persona.login}
								</a>
							{/if}
							{#if v.issue}
								<a href={v.issue.htmlUrl} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 underline-offset-4 hover:underline">
									#{v.issue.number} on fake GitHub <ExternalLinkIcon class="size-3" />
								</a>
								<a href={issueHref(v.issue.issueKey)} class="underline-offset-4 hover:underline">granary's view of {v.issue.issueKey}</a>
							{/if}
							{#if v.timeline.length}<span>▸ evidence ({v.timeline.length} events)</span>{/if}
						</div>
					</summary>
					{#if v.timeline.length}
						<div class="bg-background mt-2 rounded border p-2"><IssueTimeline entries={v.timeline} /></div>
					{/if}
				</details>
			</li>
		{/each}
	</ul>
{/if}
