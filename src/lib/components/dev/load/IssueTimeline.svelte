<!-- An issue's ledger timeline (evidence for violations, persona issues). -->
<script lang="ts">
	import type { Violation } from '$lib/schemas/dev';
	let { entries, origin = null }: { entries: Violation['timeline']; origin?: number | null } = $props();
	const t0 = $derived(origin ?? entries[0]?.at ?? 0);
	const rel = (at: number) => {
		const d = at - t0;
		return d < 1000 ? `+${d} ms` : `+${(d / 1000).toFixed(1)} s`;
	};
	const ICON: Record<string, string> = { opened: '●', closed: '■', reopened: '↺', comment: '💬', delivery: '→' };
</script>

<ol class="space-y-0.5 font-mono text-xs">
	{#each entries as e, i (i)}
		<li class="grid grid-cols-[4.5rem_1rem_1fr] gap-1.5">
			<span class="text-muted-foreground text-right tabular-nums">{rel(e.at)}</span>
			<span aria-hidden="true" class="text-muted-foreground">{ICON[e.type] ?? '·'}</span>
			<span class="min-w-0 break-words"><span class="text-muted-foreground">{e.type}</span> {e.detail}</span>
		</li>
	{/each}
</ol>
