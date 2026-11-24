<!--
	"Let them in" on an Activity row granary closed (ADR 0313): an icon that
	opens a dialog to allowlist the item's author for its repository, its
	owner or everywhere, lift an active block, and reopen what granary closed
	on them there. Admins only; others see it disabled with a reason.
-->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import UserCheckIcon from '@lucide/svelte/icons/user-check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import type { ActivityItem, AdmitScope } from '$lib/schemas/api';
	import { admitAuthor } from '$lib/remote/allowlist.remote';
	import { describeError } from './format';
	import { isAdmin } from './session';

	let { item, onchange }: { item: ActivityItem; onchange: () => void } = $props();

	const author = $derived(item.issue?.author ?? '');
	const owner = $derived(item.issue?.owner ?? '');
	const repository = $derived(item.issue ? `${item.issue.owner}/${item.issue.repo}` : '');
	const blocked = $derived(item.decision?.reason === 'blocklist');
	const admin = $derived(isAdmin());
	const label = $derived(`Let ${author} in and reopen what granary closed on them`);

	let open = $state(false);
	let scope = $state<AdmitScope>('repository');
	let busy = $state(false);

	const choices = $derived([
		{ value: 'repository' as const, title: `Only ${repository}`, hint: 'Their issues and pull requests there stay open.' },
		{ value: 'owner' as const, title: `Every repository of ${owner}`, hint: 'Also those added later.' },
		{ value: 'everywhere' as const, title: 'Everywhere', hint: 'Every repository granary gates.' }
	]);
	const where = $derived(scope === 'repository' ? repository : scope === 'owner' ? `every repository of ${owner}` : 'every repository');

	async function confirm() {
		busy = true;
		try {
			const r = await admitAuthor({ issueKey: item.issueKey, scope });
			const parts = [r.added ? `Allowlisted for ${where}` : `Already allowlisted for ${where}`];
			if (r.unblocked) parts.push('block lifted');
			parts.push(r.reopening.length ? `reopening ${r.reopening.join(', ')}` : 'nothing to reopen');
			toast.success(`Let ${r.login} in`, { description: `${parts.join('; ')}.` });
			open = false;
			onchange();
		} catch (e) {
			toast.error(`Could not let ${author} in`, { description: describeError(e).message });
		} finally {
			busy = false;
		}
	}
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<span {...props} class="inline-flex" class:cursor-not-allowed={!admin}>
				<Button
					variant="ghost"
					size="icon"
					class="size-8"
					aria-label={label}
					data-testid="admit-author"
					disabled={!admin}
					onclick={() => {
						scope = 'repository';
						open = true;
					}}
				>
					<UserCheckIcon />
				</Button>
			</span>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content>{admin ? label : 'Only admins can let people in'}</Tooltip.Content>
</Tooltip.Root>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md" data-testid="admit-author-dialog">
		<Dialog.Header>
			<Dialog.Title>Let {author} in?</Dialog.Title>
			<Dialog.Description>
				granary adds {author} to the allowlist, reopens every issue and pull request it closed on them in {where}, and comments on each to
				tell them (the comment is on the Policy page).{#if blocked}
					Their block is lifted too.{/if}
			</Dialog.Description>
		</Dialog.Header>
		<fieldset class="grid gap-2" disabled={busy}>
			<legend class="sr-only">Where to let them in</legend>
			{#each choices as c (c.value)}
				<label class="hover:bg-accent has-[:checked]:border-primary has-[:checked]:bg-accent/50 flex cursor-pointer items-start gap-3 rounded-lg border p-3">
					<input type="radio" name="admit-scope" value={c.value} bind:group={scope} class="accent-primary mt-1" />
					<span class="grid gap-0.5">
						<span class="text-sm font-medium">{c.title}</span>
						<span class="text-muted-foreground text-xs">{c.hint}</span>
					</span>
				</label>
			{/each}
		</fieldset>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={busy}>Cancel</Button>
			<Button onclick={confirm} disabled={busy} data-testid="admit-author-confirm">
				{#if busy}<LoaderCircleIcon class="animate-spin" />{:else}<UserCheckIcon />{/if} Let them in
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
