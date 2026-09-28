<!-- One persona (ADR 0076): statechart with its current state, narrated timeline, issues, data. -->
<script lang="ts">
	import { page } from '$app/state';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { getPersona } from '$lib/remote/load.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import { issueHref } from '$lib/components/app/format';
	import ChartTree from '$lib/components/actors/ChartTree.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import KindIcon from '$lib/components/dev/load/KindIcon.svelte';
	import PersonaState from '$lib/components/dev/load/PersonaState.svelte';
	import PersonaTimeline from '$lib/components/dev/load/PersonaTimeline.svelte';
	import OutcomeBadge from '$lib/components/dev/load/OutcomeBadge.svelte';
	import IssueTimeline from '$lib/components/dev/load/IssueTimeline.svelte';
	import { duration, scenarioHref } from '$lib/components/dev/load/meta';
	import { PERSONA_KINDS, type PersonaKind } from '$lib/schemas/dev';

	const kind = $derived(page.params.kind as PersonaKind);
	const name = $derived(page.params.name ?? '');
	const valid = $derived((PERSONA_KINDS as readonly string[]).includes(kind));
	const persona = $derived(valid ? getPersona({ kind, name }) : null);

	$effect(() => {
		const q = persona;
		if (!q) return;
		const t = setInterval(() => {
			if (q.current && q.current.summary.finished) return;
			void q.refresh();
		}, 1500);
		return () => clearInterval(t);
	});

	const EXPECT = { open: 'granary should leave its issues open', closed: 'granary should close its issues', varies: 'expectations vary per case', none: 'opens no issues' } as const;
</script>

{#if !persona}
	<PageHeader title="Unknown persona kind" />
	<p class="text-muted-foreground text-sm">No persona kind “{kind}”. <a class="underline" href="/admin/load/personas">All personas</a></p>
{:else}
	<svelte:boundary>
		{@const d = await persona}
		{@const s = d.summary}
		{@const repoBase = d.issues[0]?.htmlUrl.replace(/\/issues\/\d+$/, '') ?? null}
		<PageHeader title={s.login} description="{d.kindInfo.title} — {d.kindInfo.description}">
			{#snippet actions()}
				<Button variant="outline" size="sm" href="/admin/load/personas?scenario={encodeURIComponent(s.scenarioId)}"><ArrowLeftIcon /> All personas</Button>
			{/snippet}
		</PageHeader>

		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" data-testid="persona-header">
			<span class="inline-flex items-center gap-1.5"><KindIcon kind={s.kind} class="size-4" /><span class="font-mono text-xs">{s.id}</span></span>
			<PersonaState activeStates={s.activeStates} finalState={s.finalState} finished={s.finished} live={s.live} />
			<StateBadge state={EXPECT[d.kindInfo.expected]} tone={d.kindInfo.expected === 'open' ? 'success' : d.kindInfo.expected === 'closed' ? 'danger' : 'info'} />
			<a class="underline-offset-4 hover:underline" href={scenarioHref(s.scenarioId)}>scenario {s.scenarioId}</a>
			<span class="text-muted-foreground">arrived <RelativeTime ms={s.arrivedAt} /> · {s.actions} actions · {s.errors} errors</span>
			{#if s.violations}<StateBadge state="{s.violations} violation(s)" tone="danger" />{/if}
		</div>

		<div class="border-primary/30 bg-primary/5 flex items-start gap-3 rounded-xl border px-5 py-4" data-testid="persona-now">
			<KindIcon kind={s.kind} class="text-primary mt-1 size-6 shrink-0" />
			<div>
				<div class="text-muted-foreground text-xs">{s.finished ? `Finished in ${s.finalState}` : `Right now: ${s.activeStates.at(-1) ?? '…'}`}{s.live ? '' : ' (frozen snapshot)'}</div>
				<p class="text-base italic">“{s.lastNote || '…'}”</p>
			</div>
		</div>

		<div class="grid gap-4 xl:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>Statechart</Card.Title>
					<Card.Description>
						{#if d.chart}<span class="font-mono">{d.chart.sourceFile}</span> — the highlighted state is where this persona is.{:else}No chart known.{/if}
					</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if d.chart}
						<div class="max-h-[42rem] overflow-auto pr-1"><ChartTree chart={d.chart} active={s.finished ? [] : s.activeStates} finalState={s.finished ? s.finalState : null} /></div>
					{/if}
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Title>Timeline</Card.Title>
					<Card.Description>What they thought (narration from their chart), did, and what happened to them. Newest first.</Card.Description>
				</Card.Header>
				<Card.Content class="max-h-[42rem] overflow-auto">
					<PersonaTimeline entries={d.timeline} issueUrl={(n) => (repoBase ? `${repoBase}/issues/${n}` : '#')} />
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Issues ({d.issues.length})</Card.Title>
				<Card.Description>Judged against the policy: allowlisted logins and OWNER/MEMBER/COLLABORATOR stay open, everyone else is closed once, with one comment.</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if d.issues.length === 0}
					<p class="text-muted-foreground text-sm">No issues (yet).</p>
				{:else}
					<ul class="divide-y rounded-lg border" data-testid="persona-issues">
						{#each d.issues as issue (issue.number)}
							<li class="p-3">
								<details>
									<summary class="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 text-sm">
										<a href={issue.htmlUrl} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline">#{issue.number}<ExternalLinkIcon class="size-3" /></a>
										<span class="min-w-0 flex-1 truncate" title={issue.title}>{issue.title}</span>
										<span class="text-muted-foreground text-xs">expected {issue.expected} · now {issue.state}{issue.closedBy ? ` by ${issue.closedBy}` : ''}{issue.latencyMs !== null ? ` in ${duration(issue.latencyMs)}` : ''} · {issue.granaryComments} granary comment(s){issue.reopened ? ` · reopened ×${issue.reopened}` : ''}</span>
										<OutcomeBadge outcome={issue.outcome} />
										<a href={issueHref(issue.issueKey)} class="text-muted-foreground text-xs underline-offset-4 hover:underline">granary's view</a>
									</summary>
									<div class="bg-muted/30 mt-2 rounded border p-2"><IssueTimeline entries={issue.timeline} /></div>
								</details>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Data model</Card.Title>
				<Card.Description>The persona actor's live data (rng state, counters, current draft…).</Card.Description>
			</Card.Header>
			<Card.Content><JsonBlock value={d.data} preset="compact" rootLabel="data" expandDepth={1} alwaysTree /></Card.Content>
		</Card.Root>
		{#snippet failed(error, reset)}
			<ErrorAlert {error} retry={() => { void persona?.refresh(); reset(); }} />
		{/snippet}
	</svelte:boundary>
{/if}
