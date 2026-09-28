<!--
	/policy/closing-message (ADR 0250–0252, 0291): the comment granary posts when it
	closes an issue or pull request. Global templates per kind, optional
	per-repository overrides. Admins edit; everyone else reads.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { toast } from 'svelte-sonner';
	import { beforeNavigate } from '$app/navigation';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
		import { describeError } from '$lib/components/app/format';
	import { isAdmin, shellData } from '$lib/components/app/session';
	import { MessageTemplateEditor } from '$lib/components/message-template';
	import {
		DEFAULT_TEMPLATES,
		validateClosingMessages,
		type ClosingMessages,
		type RepoTemplateOverride
	} from '$lib/schemas/message-template';
	import { getClosingMessages, saveClosingMessages } from '$lib/remote/settings.remote';

	// Top-level await (experimental async): the page renders with the data during SSR.
	const initial = await getClosingMessages();
	const admin = $derived(isAdmin());

	let draft = $state<ClosingMessages>(structuredClone(initial.messages));
	let saved = $state(JSON.stringify(initial.messages)); // what the server has, to detect unsaved changes
	let changed = $state<{ by: string | null; at: number | null }>({ by: initial.updatedBy, at: initial.updatedAt });
	let busy = $state(false);
	let newRepo = $state('');
	let justSaved = $state(false);

	const dirty = $derived(JSON.stringify(draft) !== saved);
	$effect(() => {
		if (dirty) justSaved = false;
	});

	// Unsaved-changes guard: in-app navigation asks; closing the tab gets the browser prompt.
	beforeNavigate((nav) => {
		if (!dirty || busy) return;
		if (!confirm('You have unsaved changes to the closing message. Leave without saving?')) nav.cancel();
	});
	$effect(() => {
		if (!dirty) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => window.removeEventListener('beforeunload', onBeforeUnload);
	});
	const problems = $derived(validateClosingMessages(draft));
	const repoKey = $derived(newRepo.trim().toLowerCase());
	const repoValid = $derived(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repoKey));

	function addRepo() {
		if (!repoValid || draft.repos[repoKey]) return;
		draft.repos[repoKey] = { issue: null, pullRequest: null };
		newRepo = '';
	}
	function removeRepo(key: string) {
		delete draft.repos[key];
	}
	function override(key: string): RepoTemplateOverride {
		return draft.repos[key]!;
	}

	async function save() {
		busy = true;
		try {
			const result = await saveClosingMessages(draft);
			draft = structuredClone(result);
			saved = JSON.stringify(result);
			changed = { by: shellData().user?.login ?? null, at: Date.now() };
			justSaved = true;
			toast.success('Closing message saved');
		} catch (e) {
			toast.error('Could not save the closing message', { description: describeError(e).message });
		} finally {
			busy = false;
		}
	}
	function discard() {
		draft = JSON.parse(saved) as ClosingMessages;
	}
</script>

<PageHeader
	title="Closing message"
	description="What granary writes when it closes an issue or pull request from someone who isn't allowed. Markdown with variables; the preview uses sample data."
/>

<div class="grid gap-4 pb-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>Issues</Card.Title>
					<Card.Description>Used for every guarded repository without its own override.</Card.Description>
				</Card.Header>
				<Card.Content>
					<MessageTemplateEditor id="tpl-issue" label="Issue closing message" kind="issue" bind:value={draft.issue} inherited={DEFAULT_TEMPLATES.issue} readonly={!admin} />
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Pull requests</Card.Title>
					<Card.Description>Used when granary closes a pull request.</Card.Description>
				</Card.Header>
				<Card.Content>
					<MessageTemplateEditor
						id="tpl-pr"
						label="Pull request closing message"
						kind="pull_request"
						bind:value={draft.pullRequest}
						inherited={DEFAULT_TEMPLATES.pull_request}
						readonly={!admin}
					/>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Per-repository overrides</Card.Title>
					<Card.Description>A repository can have its own text; anything not overridden uses the templates above.</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-6">
					{#each Object.keys(draft.repos).sort() as key (key)}
						{@const o = override(key)}
						<div class="grid gap-4 rounded-lg border p-4" data-testid="repo-override">
							<div class="flex items-center justify-between gap-2">
								<span class="font-mono text-sm">{key}</span>
								{#if admin}<Button variant="ghost" size="sm" onclick={() => removeRepo(key)}><TrashIcon class="size-4" />Remove</Button>{/if}
							</div>
							<MessageTemplateEditor
								id="tpl-{key}-issue"
								label="{key} · issues"
								kind="issue"
								bind:value={() => o.issue ?? null, (v) => (o.issue = v)}
								inherited={draft.issue ?? DEFAULT_TEMPLATES.issue}
								inheritedLabel="the issue template above"
								readonly={!admin}
							/>
							<MessageTemplateEditor
								id="tpl-{key}-pr"
								label="{key} · pull requests"
								kind="pull_request"
								bind:value={() => o.pullRequest ?? null, (v) => (o.pullRequest = v)}
								inherited={draft.pullRequest ?? DEFAULT_TEMPLATES.pull_request}
								inheritedLabel="the pull request template above"
								readonly={!admin}
							/>
						</div>
					{:else}
						<p class="text-muted-foreground text-sm">No overrides.</p>
					{/each}
					{#if admin}
						<form
							class="flex flex-wrap items-center gap-2"
							onsubmit={(e) => {
								e.preventDefault();
								addRepo();
							}}
						>
							<Input bind:value={newRepo} placeholder="owner/repo" class="max-w-xs font-mono" aria-label="Repository to override" />
							<Button type="submit" variant="outline" disabled={!repoValid || !!draft.repos[repoKey]}><PlusIcon class="size-4" />Add override</Button>
						</form>
					{/if}
				</Card.Content>
			</Card.Root>

			<div
				class="bg-background sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-t-lg border-t px-1 py-3 shadow-[0_-6px_12px_-8px_rgb(0_0_0/0.25)]"
				data-testid="closing-message-actions"
			>
				{#if admin}
					<Button onclick={save} disabled={!dirty || busy || problems.length > 0} data-testid="save-closing-message">
						{#if busy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}Save
					</Button>
					<Button variant="ghost" onclick={discard} disabled={!dirty || busy}>Discard changes</Button>
					{#if problems.length}<span class="text-destructive text-sm">Fix {problems.length} problem{problems.length === 1 ? '' : 's'} first.</span>
					{:else if dirty}<span class="text-sm text-amber-700 dark:text-amber-400" data-testid="unsaved">Unsaved changes</span>
					{:else if justSaved}<span class="text-muted-foreground inline-flex items-center gap-1 text-sm" data-testid="saved"><CheckIcon class="size-4" />Saved</span>{/if}
				{:else}
					<span class="text-muted-foreground text-sm">Only admins can change the closing message.</span>
				{/if}
				{#if changed.at}
					<span class="text-muted-foreground ml-auto text-xs">Last changed by {changed.by} <RelativeTime ms={changed.at} /></span>
				{/if}
			</div>
		</div>
