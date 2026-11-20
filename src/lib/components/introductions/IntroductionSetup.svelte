<!--
	Where introductions come from (ADR 0310) and what each repository still
	needs. GitHub has no API to create a discussion category, so granary
	checks and links to the exact page; "Check again" re-reads every
	repository. Also: each owner's org discussions repository, and the reply
	posted on an approved introduction.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { toast } from 'svelte-sonner';
	import type { IntroductionSetupEntry, IntroductionSetupStatus } from '$lib/schemas/api';
	import { APPROVED_VARIABLES } from '$lib/schemas/message-template';
	import { checkIntroductionSetup, saveApprovedTemplate, setOrgRepository } from '$lib/remote/introductions.remote';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';

	let { setup }: { setup: IntroductionSetupStatus } = $props();
	const admin = $derived(isAdmin());

	const LABELS: Record<IntroductionSetupEntry['state'], string> = {
		ready: 'Ready',
		'no-category': 'No Introductions category',
		disabled: 'Discussions are off',
		'no-access': 'No Discussions access',
		missing: 'Repository not found',
		error: 'Check failed',
		unchecked: 'Not checked yet'
	};
	const TONES = { ready: 'success', 'no-category': 'warning', disabled: 'warning', 'no-access': 'danger', missing: 'muted', error: 'danger', unchecked: 'muted' } as const;

	const notReady = $derived(setup.entries.filter((e) => e.state !== 'ready' && !(e.org && e.state === 'missing')).length);

	let checking = $state(false);
	async function checkAgain() {
		checking = true;
		try {
			const s = await checkIntroductionSetup();
			const ready = s.entries.filter((e) => e.state === 'ready').length;
			toast.success(`Checked ${s.entries.length} repositor${s.entries.length === 1 ? 'y' : 'ies'}`, { description: `${ready} ready` });
		} catch (e) {
			toast.error('Could not check', { description: describeError(e).message });
		} finally {
			checking = false;
		}
	}

	let orgOwner = $state('');
	let orgRepo = $state('');
	async function saveOrg(event: SubmitEvent) {
		event.preventDefault();
		try {
			await setOrgRepository({ owner: orgOwner.trim(), repo: orgRepo.trim() === '' || orgRepo.trim() === '.github' ? null : orgRepo.trim() });
			toast.success(`Org discussions repository of ${orgOwner.trim()} saved`);
			orgOwner = '';
			orgRepo = '';
		} catch (e) {
			toast.error('Could not save', { description: describeError(e).message });
		}
	}

	let template = $state<string | null>(null);
	const draft = $derived(template ?? setup.approvedTemplate.template);
	let savingTemplate = $state(false);
	async function saveTemplate(value: string | null) {
		savingTemplate = true;
		try {
			await saveApprovedTemplate({ template: value });
			template = null;
			toast.success(value === null ? 'Back to the built-in reply' : 'Reply saved');
		} catch (e) {
			toast.error('Could not save the reply', { description: describeError(e).message });
		} finally {
			savingTemplate = false;
		}
	}
</script>

<Card.Root data-testid="introduction-setup">
	<Card.Header>
		<Card.Title>Where people introduce themselves</Card.Title>
		<Card.Description>
			A discussion category named <strong>{setup.category.name}</strong> in each gated repository; an introduction there lets them in to that
			repository. One in an owner's org discussions repository (<code>.github</code> unless you name another) lets them in to all of the owner's
			repositories. Closing comments link to it as soon as it is ready.
		</Card.Description>
		<Card.Action>
			<AdminOnly reason="Only admins can run the check">
				{#snippet children({ disabled })}
					<Button variant="outline" size="sm" onclick={checkAgain} disabled={disabled || checking || !setup.connected} data-testid="introduction-setup-check">
						{#if checking}<LoaderCircleIcon class="animate-spin" />{:else}<RefreshCwIcon />{/if} Check again
					</Button>
				{/snippet}
			</AdminOnly>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if !setup.connected}
			<p class="text-muted-foreground text-sm">GitHub is not connected yet — <a class="underline" href="/settings/github">connect it</a> first.</p>
		{:else}
			{#if setup.access && !setup.access.ready}
				<div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="introduction-access">
					<p class="font-medium">The GitHub App needs Discussions access</p>
					<ol class="mt-1 ml-4 list-decimal">
						{#if !setup.access.appPermission || !setup.access.appEvent}
							<li>
								In the <a class="underline" href={setup.access.permissionsUrl} target="_blank" rel="noreferrer">app's permissions</a>: Repository permissions →
								Discussions: <strong>Read and write</strong>; Subscribe to events → <strong>Discussion</strong>; Save.
							</li>
						{/if}
						{#if setup.access.pendingInstallations.length}
							<li>On each installation ({setup.access.pendingInstallations.map((i) => i.account).join(', ')}): Review request → Accept new permissions.</li>
						{/if}
						<li>Then “Check again”.</li>
					</ol>
				</div>
			{/if}
			{#if notReady > 0}
				<div class="text-sm">
					<p class="font-medium">To add the category on GitHub (there is no API for it):</p>
					<ol class="text-muted-foreground mt-1 ml-4 list-decimal">
						<li>If Discussions are off: the repository's Settings → General → Features → <strong>Discussions</strong>.</li>
						<li>
							Discussions → Categories → New category: name <strong>{setup.category.name}</strong> <CopyButton text={setup.category.name} label="Copy the name" />, emoji
							<code>{setup.category.emoji}</code>, format <strong>Open-ended discussion</strong>, description:
							<span class="italic">{setup.category.description}</span> <CopyButton text={setup.category.description} label="Copy the description" />
						</li>
					</ol>
				</div>
			{/if}
			<Table.Root stack>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Repository</Table.Head>
						<Table.Head>Introductions</Table.Head>
						<Table.Head>Next step</Table.Head>
						<Table.Head class="text-right">Checked</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each setup.entries as e (`${e.owner}/${e.repo}`)}
						<Table.Row data-testid="introduction-setup-row" data-repo="{e.owner}/{e.repo}" data-state={e.state}>
							<Table.Cell>
								<code class="text-sm">{e.owner}/{e.repo}</code>
								{#if e.org}<div class="text-muted-foreground text-xs">org discussions: all of {e.owner}</div>{/if}
							</Table.Cell>
							<Table.Cell>
								<StateBadge state={e.state} tone={TONES[e.state]} label={LABELS[e.state]} />
								{#if e.error}<div class="text-muted-foreground max-w-72 truncate text-xs" title={e.error}>{e.error}</div>{/if}
							</Table.Cell>
							<Table.Cell class="text-sm">
								{#if e.state === 'ready' && e.newUrl}
									<a class="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={e.newUrl} target="_blank" rel="noreferrer">Introduce yourself link <ExternalLinkIcon class="size-3" /></a>
								{:else if e.state === 'disabled'}
									<a class="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={e.settingsUrl} target="_blank" rel="noreferrer">Turn on Discussions <ExternalLinkIcon class="size-3" /></a>
								{:else if e.state === 'no-category'}
									<a class="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={e.newCategoryUrl} target="_blank" rel="noreferrer">Add the category <ExternalLinkIcon class="size-3" /></a>
								{:else if e.state === 'missing' && e.org}
									<span class="text-muted-foreground">Optional: create <code>{e.owner}/{e.repo}</code> and enable org discussions</span>
								{:else if e.state === 'no-access'}
									<span class="text-muted-foreground">Grant Discussions access (above)</span>
								{:else}
									<span class="text-muted-foreground">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-muted-foreground text-right text-xs">{#if e.checkedAt}<RelativeTime ms={e.checkedAt} />{:else}—{/if}</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row class="hover:bg-transparent">
							<Table.Cell colspan={4} class="text-muted-foreground py-6 text-center">No gated repositories yet.</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Card.Content>
</Card.Root>

<div class="grid items-start gap-4 lg:grid-cols-2">
	<Card.Root>
		<Card.Header>
			<Card.Title>The reply to an approved introduction</Card.Title>
			<Card.Description>
				Posted on the discussion when you approve.
				{#each APPROVED_VARIABLES as v (v.name)}<code class="mr-1" title={v.description}>{`{{${v.name}}}`}</code>{/each}
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			<Textarea rows={4} value={draft} oninput={(e) => (template = (e.currentTarget as HTMLTextAreaElement).value)} readonly={!admin} data-testid="approved-template" />
			<div class="flex flex-wrap gap-2">
				<AdminOnly reason="Only admins can change the reply">
					{#snippet children({ disabled })}
						<Button size="sm" onclick={() => saveTemplate(draft)} disabled={disabled || savingTemplate || template === null}>Save</Button>
					{/snippet}
				</AdminOnly>
				{#if setup.approvedTemplate.custom}
					<AdminOnly reason="Only admins can change the reply">
						{#snippet children({ disabled })}
							<Button size="sm" variant="ghost" onclick={() => saveTemplate(null)} disabled={disabled || savingTemplate}>Use the built-in reply</Button>
						{/snippet}
					</AdminOnly>
				{/if}
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Org discussions repositories</Card.Title>
			<Card.Description>
				GitHub backs an organization's discussions with one repository, <code>.github</code> by default. Introductions there are about every
				repository of the owner.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			{#if Object.keys(setup.orgRepositories).length}
				<ul class="text-sm">
					{#each Object.entries(setup.orgRepositories) as [owner, repo] (owner)}
						<li><code>{owner}</code> → <code>{owner}/{repo}</code></li>
					{/each}
				</ul>
			{/if}
			<form class="flex flex-wrap items-end gap-2" onsubmit={saveOrg}>
				<div class="grid gap-1">
					<Label for="org-owner">Owner</Label>
					<Input id="org-owner" class="w-36" bind:value={orgOwner} placeholder="acme" disabled={!admin} required />
				</div>
				<div class="grid gap-1">
					<Label for="org-repo">Repository</Label>
					<Input id="org-repo" class="w-36" bind:value={orgRepo} placeholder=".github" disabled={!admin} />
				</div>
				<AdminOnly reason="Only admins can change this">
					{#snippet children({ disabled })}
						<Button type="submit" size="sm" variant="outline" {disabled}>Save</Button>
					{/snippet}
				</AdminOnly>
			</form>
		</Card.Content>
	</Card.Root>
</div>
