<!-- The one headline of /ops (ADR 0104): can I sleep? Calm either way. -->
<script lang="ts">
	import type { OpsStatus } from '$lib/ops/contract';
	import MoonStarIcon from '@lucide/svelte/icons/moon-star';
	import CoffeeIcon from '@lucide/svelte/icons/coffee';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';

	let { status }: { status: OpsStatus } = $props();
</script>

<section
	class="rounded-2xl border p-6 {status.mode === 'inactive'
		? 'bg-muted/40'
		: status.sleepOk
			? 'border-emerald-600/20 bg-emerald-600/[0.05] dark:border-emerald-400/20 dark:bg-emerald-400/[0.06]'
			: 'border-amber-600/25 bg-amber-500/[0.06] dark:border-amber-400/20 dark:bg-amber-400/[0.06]'}"
	data-testid="sleep-hero"
	data-sleep-ok={status.sleepOk}
>
	<div class="flex items-start gap-4">
		<div class="bg-background flex size-12 shrink-0 items-center justify-center rounded-full border">
			{#if status.mode === 'inactive'}<CircleDashedIcon class="text-muted-foreground size-6" />
			{:else if status.sleepOk}<MoonStarIcon class="size-6 text-emerald-700 dark:text-emerald-400" />
			{:else}<CoffeeIcon class="size-6 text-amber-700 dark:text-amber-400" />{/if}
		</div>
		<div class="min-w-0">
			<h2 class="text-3xl font-semibold tracking-tight">
				{#if status.mode === 'inactive'}Ops isn't running{:else if status.sleepOk}Sleeping is fine{:else}Needs you (not urgent){/if}
			</h2>
			<p class="text-muted-foreground mt-1 text-sm">
				{#if status.mode === 'inactive'}
					The operations module hasn't started, so nothing is being backed up or exported yet.
				{:else if status.sleepOk}
					Backups are off-site and verified, the last restore drill passed, and nothing is waiting for you.
				{:else}
					Nothing here pages anyone. Have a coffee first — these can wait until you're ready.
				{/if}
				{#if status.handledLast24h}
					{status.handledLast24h} thing{status.handledLast24h === 1 ? ' was' : 's were'} handled automatically in the last 24 h.
				{/if}
			</p>
			{#if status.reasons.length && !status.sleepOk}
				<ul class="mt-3 list-disc space-y-0.5 pl-5 text-sm">
					{#each status.reasons as r (r)}<li>{r}</li>{/each}
				</ul>
			{/if}
			{#if status.mode === 'degraded'}
				<p class="mt-2 text-sm">Running in <strong>degraded</strong> mode: configuration is readable, but nothing that needs secrets runs. See <a class="underline" href="/ops/secrets">Secrets</a>.</p>
			{/if}
		</div>
	</div>
</section>
