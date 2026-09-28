<!-- One persona at a glance: who, current state, what they last said, outcomes. -->
<script lang="ts">
	import type { PersonaSummary } from '$lib/schemas/dev';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import PersonaState from './PersonaState.svelte';
	import KindIcon from './KindIcon.svelte';
	import { personaHref } from './meta';

	let { p }: { p: PersonaSummary } = $props();
</script>

<a
	href={personaHref(p.kind, p.name)}
	data-testid="persona-card"
	data-kind={p.kind}
	class="bg-card hover:border-primary/40 group flex flex-col gap-2 rounded-lg border p-3 transition-colors {p.violations
		? 'border-red-500/40'
		: ''}"
>
	<div class="flex items-center gap-2">
		<KindIcon kind={p.kind} class="text-muted-foreground size-4 shrink-0" />
		<span class="truncate font-mono text-sm font-medium group-hover:underline">{p.login}</span>
		<span class="ml-auto"><PersonaState activeStates={p.activeStates} finalState={p.finalState} finished={p.finished} live={p.live} /></span>
	</div>
	<p class="text-muted-foreground line-clamp-2 min-h-8 text-xs italic">{p.lastNote || '…'}</p>
	<div class="text-muted-foreground flex flex-wrap items-center gap-x-3 text-xs tabular-nums">
		<span title="issues opened">{p.issuesOpened} opened</span>
		<span title="closed by granary">{p.issuesClosed} closed</span>
		<span>{p.actions} actions</span>
		{#if p.errors}<span class="text-amber-700 dark:text-amber-400">{p.errors} errors</span>{/if}
		{#if p.violations}<span class="font-medium text-red-700 dark:text-red-400">{p.violations} violation{p.violations === 1 ? '' : 's'}</span>{/if}
		<RelativeTime ms={p.lastActivityAt} class="ml-auto" />
	</div>
</a>
