<!--
	Introductions (ADR 0310): people who were closed introduce themselves in a
	repository's Introductions discussion category; admins work through them
	here. Approve allowlists them for the repository (or, from the org
	discussions repository, the owner), reopens what granary closed on them and
	replies on the discussion.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { INTRODUCTION_STATES, type IntroductionStateName } from '$lib/schemas/api';
	import { getIntroductionCounts, getIntroductionSetup, listIntroductions } from '$lib/remote/introductions.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import FilterTabs from '$lib/components/app/FilterTabs.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import IntroductionCard from '$lib/components/introductions/IntroductionCard.svelte';
	import IntroductionSetup from '$lib/components/introductions/IntroductionSetup.svelte';

	const LABELS: Record<IntroductionStateName, string> = {
		pending: 'Waiting',
		approving: 'Approving',
		approved: 'Approved',
		declined: 'Declined',
		withdrawn: 'Withdrawn',
		failed: 'Failed'
	};

	/** `?state=` filters; no parameter = waiting for a decision; `?state=all` = everything. */
	const state = $derived.by((): IntroductionStateName | undefined => {
		const s = page.url.searchParams.get('state');
		if (s === 'all') return undefined;
		return (INTRODUCTION_STATES as readonly string[]).includes(s ?? '') ? (s as IntroductionStateName) : 'pending';
	});
	const current = $derived(page.url.searchParams.get('state') === 'all' ? 'all' : (state ?? 'pending'));
	const list = $derived(listIntroductions(state ? { state } : {}));
	const counts = getIntroductionCounts();
	const setup = getIntroductionSetup();

	function refresh() {
		void list.refresh();
		void counts.refresh();
		void setup.refresh();
	}

	/** While an approval is being carried out, look again shortly. */
	$effect(() => {
		if (!(list.current ?? []).some((i) => i.state === 'approving')) return;
		const t = setTimeout(() => void list.refresh(), 1500);
		return () => clearTimeout(t);
	});

	const tabLabels = $derived(
		Object.fromEntries([...INTRODUCTION_STATES.map((s) => [s, `${LABELS[s]}${counts.current?.[s] ? ` (${counts.current[s]})` : ''}`]), ['all', 'All']])
	);
</script>

<PageHeader
	title="Introductions"
	description="People granary closed can introduce themselves in an Introductions discussion. Approve to let them in, reopen what was closed and tell them on the discussion."
>
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refresh}><RefreshCwIcon /> Refresh</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4">
	<FilterTabs param="state" values={[...INTRODUCTION_STATES.filter((s) => s !== 'pending'), 'all']} current={current === 'pending' ? null : current} labels={tabLabels} allLabel={tabLabels.pending} label="Filter introductions" />

	<svelte:boundary>
		{@const items = await list}
		<div class="grid gap-3" data-testid="introductions">
			{#each items as intro (intro.introKey)}
				<IntroductionCard {intro} onchange={refresh} />
			{:else}
				<p class="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm" data-testid="introductions-empty">
					{state === 'pending' ? 'No introductions are waiting for you.' : 'Nothing here.'}
				</p>
			{/each}
		</div>
		{#snippet failed(error, reset)}
			<ErrorAlert {error} retry={() => { void list.refresh(); reset(); }} />
		{/snippet}
	</svelte:boundary>

	<svelte:boundary>
		{@const s = await setup}
		<IntroductionSetup setup={s} />
		{#snippet failed(error, reset)}
			<ErrorAlert {error} retry={() => { void setup.refresh(); reset(); }} />
		{/snippet}
	</svelte:boundary>
</div>
