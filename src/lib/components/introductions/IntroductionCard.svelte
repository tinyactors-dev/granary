<!--
	One introduction (ADR 0310): who, where, what they wrote, what granary
	closed on them, and the decision. Approve allowlists them for the scope,
	reopens those items and replies on the discussion; Decline is recorded
	here only.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import type { IntroductionSummary } from '$lib/schemas/api';
	import { approveIntroduction, declineIntroduction } from '$lib/remote/introductions.remote';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { reasonLabel } from '$lib/components/app/glossary';

	let { intro, onchange }: { intro: IntroductionSummary; onchange: () => void } = $props();

	const STATE_LABELS: Record<IntroductionSummary['state'], string> = {
		pending: 'Waiting for you',
		approving: 'Approving…',
		approved: 'Approved',
		declined: 'Declined',
		withdrawn: 'Withdrawn',
		failed: 'Approval failed'
	};
	const TONES = { pending: 'info', approving: 'warning', approved: 'success', declined: 'muted', withdrawn: 'muted', failed: 'danger' } as const;

	const scopeLabel = $derived(intro.scope.includes('/') ? intro.scope : `all of ${intro.scope}`);
	let busy = $state<'approve' | 'decline' | null>(null);
	let declining = $state(false);
	let note = $state('');

	async function approve() {
		busy = 'approve';
		try {
			await approveIntroduction({ introKey: intro.introKey });
			toast.success(`Approving ${intro.author}`, { description: `Allowlisted for ${scopeLabel}${intro.closedItems.length ? `, reopening ${intro.closedItems.length}` : ''}, replying on the discussion.` });
			onchange();
		} catch (e) {
			toast.error('Could not approve', { description: describeError(e).message });
		} finally {
			busy = null;
		}
	}

	async function decline() {
		busy = 'decline';
		try {
			await declineIntroduction({ introKey: intro.introKey, ...(note.trim() ? { note: note.trim() } : {}) });
			toast.success(`Declined ${intro.author}'s introduction`);
			declining = false;
			onchange();
		} catch (e) {
			toast.error('Could not decline', { description: describeError(e).message });
		} finally {
			busy = null;
		}
	}
</script>

<Card.Root data-testid="introduction" data-intro-key={intro.introKey} data-state={intro.state}>
	<Card.Header class="gap-1">
		<div class="flex flex-wrap items-center gap-2">
			<Card.Title class="text-base">{intro.author}</Card.Title>
			<Badge variant="outline" title={intro.scope.includes('/') ? 'Approving lets them in to this repository' : `Approving lets them in to every repository of ${intro.scope}`}>{scopeLabel}</Badge>
			<StateBadge state={intro.state} tone={TONES[intro.state]} label={STATE_LABELS[intro.state]} />
			<span class="text-muted-foreground ml-auto text-xs"><RelativeTime ms={intro.receivedAt} /></span>
		</div>
		<Card.Description>
			<a class="hover:text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline" href={intro.htmlUrl} target="_blank" rel="noreferrer">
				{intro.title} <ExternalLinkIcon class="size-3" />
			</a>
			<span class="text-muted-foreground"> · {intro.owner}/{intro.repo}#{intro.number}</span>
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3 text-sm">
		<p class="max-h-60 overflow-auto break-words whitespace-pre-wrap" data-testid="introduction-body">{intro.body || '(no text)'}</p>
		<div class="text-muted-foreground flex flex-col gap-1 text-xs">
			<span data-testid="introduction-policy">
				Now: {intro.policy.allowed ? 'allowed' : 'closed'} — {reasonLabel(intro.policy.reason)}{intro.association && intro.association !== 'NONE' ? ` (${intro.association.toLowerCase()})` : ''}
			</span>
			{#if intro.closedItems.length}
				<span>Closed on them in {scopeLabel}{intro.state === 'pending' || intro.state === 'failed' ? ', reopened when you approve' : ''}:</span>
				<ul class="ml-4 list-disc" data-testid="introduction-closed-items">
					{#each intro.closedItems as item (item.issueKey)}
						<li><a class="underline-offset-4 hover:underline" href="/issues/{item.issueKey}">{item.owner}/{item.repo}#{item.number}</a> {item.title}</li>
					{/each}
				</ul>
			{/if}
			{#if intro.decidedBy}
				<span>{STATE_LABELS[intro.state]} by {intro.decidedBy}{#if intro.decidedAt} · <RelativeTime ms={intro.decidedAt} />{/if}{intro.note ? ` — “${intro.note}”` : ''}</span>
			{/if}
			{#if intro.action && intro.action.state !== 'done'}
				<span class={intro.action.state === 'dead' ? 'text-destructive' : ''}>
					GitHub: {intro.action.state === 'dead' ? 'gave up' : intro.action.state}{intro.action.attempts > 1 ? ` (attempt ${intro.action.attempts})` : ''}{intro.action.lastError ? ` — ${intro.action.lastError}` : ''}
				</span>
			{/if}
		</div>
		{#if declining}
			<div class="flex flex-col gap-2">
				<Textarea bind:value={note} rows={2} placeholder="A note for the other admins (optional, not posted on GitHub)" maxlength={2000} />
				<div class="flex gap-2">
					<Button size="sm" variant="destructive" onclick={decline} disabled={busy !== null} data-testid="introduction-decline-confirm">
						{#if busy === 'decline'}<LoaderCircleIcon class="animate-spin" />{:else}<XIcon />{/if} Decline
					</Button>
					<Button size="sm" variant="ghost" onclick={() => (declining = false)} disabled={busy !== null}>Cancel</Button>
				</div>
			</div>
		{/if}
	</Card.Content>
	{#if (intro.state === 'pending' || intro.state === 'failed') && !declining}
		<Card.Footer class="flex flex-wrap gap-2">
			<AdminOnly reason="Only admins can decide on introductions">
				{#snippet children({ disabled })}
					<Button size="sm" onclick={approve} disabled={disabled || busy !== null} data-testid="introduction-approve">
						{#if busy === 'approve'}<LoaderCircleIcon class="animate-spin" />{:else}<CheckIcon />{/if}
						{intro.state === 'failed' ? 'Try again' : 'Approve'}
					</Button>
				{/snippet}
			</AdminOnly>
			{#if intro.state === 'pending'}
				<AdminOnly reason="Only admins can decide on introductions">
					{#snippet children({ disabled })}
						<Button size="sm" variant="outline" onclick={() => (declining = true)} disabled={disabled || busy !== null} data-testid="introduction-decline">
							<XIcon /> Decline
						</Button>
					{/snippet}
				</AdminOnly>
			{/if}
		</Card.Footer>
	{/if}
</Card.Root>
