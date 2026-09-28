<!--
	"While you were away" (ADR 0100, 0104): on every page for signed-in users,
	summarising what ops handled since the last visit and what needs a human
	when convenient. Calm by design — nothing here is urgent. Renders nothing
	when the ops module isn't running (the query returns null).
-->
<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import MoonStarIcon from '@lucide/svelte/icons/moon-star';
	import XIcon from '@lucide/svelte/icons/x';
	import { page } from '$app/state';
	import { getOpsBanner, markOpsVisited } from '$lib/remote/ops.remote';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';

	const banner = getOpsBanner();
	let dismissing = $state(false);
	/** Hidden for this page view after dismissal, even if attention items remain. */
	let hidden = $state(false);

	async function dismiss() {
		dismissing = true;
		try {
			await markOpsVisited();
			hidden = true;
		} catch {
			hidden = true;
		} finally {
			dismissing = false;
		}
	}
</script>

<svelte:boundary>
	{@const b = await banner}
	{#if b?.show && !hidden}
		<aside
			class="flex items-start gap-3 rounded-xl border border-sky-600/20 bg-sky-600/[0.06] px-4 py-3 text-sm dark:border-sky-400/20 dark:bg-sky-400/[0.07]"
			data-testid="ops-banner"
			aria-label="While you were away"
		>
			<MoonStarIcon class="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-400" />
			<div class="min-w-0 flex-1 space-y-1">
				<p class="font-medium">While you were away</p>
				<p class="text-muted-foreground">{b.summary}</p>
				{#if b.attention.length}
					<ul class="space-y-0.5">
						{#each b.attention as a (a.id)}
							<li>
								<a class="underline-offset-2 hover:underline" href="/ops/conditions#{a.id}">{a.title}</a>
								{#if a.since}<span class="text-muted-foreground"> · since <RelativeTime ms={a.since} /></span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
				{#if !page.url.pathname.startsWith('/ops')}
					<a href="/ops" class="text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">Open Ops</a>
				{/if}
			</div>
			<Button variant="ghost" size="icon-sm" aria-label="Dismiss until something new happens" title="Dismiss until something new happens" disabled={dismissing} onclick={dismiss}>
				<XIcon />
			</Button>
		</aside>
	{/if}
	{#snippet pending()}{/snippet}
	{#snippet failed()}{/snippet}
</svelte:boundary>
