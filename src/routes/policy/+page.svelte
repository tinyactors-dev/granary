<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import { addAllowedUser, listAllowedUsers, removeAllowedUser } from '$lib/remote/allowlist.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import TableSkeleton from '$lib/components/app/TableSkeleton.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';
	import Blocklist from '$lib/components/policy/Blocklist.svelte';

	const users = listAllowedUsers();
	const admin = $derived(isAdmin());

	/** Login pending removal (drives the confirm dialog). */
	let removing = $state<string | null>(null);
	let removeBusy = $state(false);

	async function confirmRemove() {
		if (!removing) return;
		const login = removing;
		removeBusy = true;
		try {
			const r = await removeAllowedUser({ login });
			if (r.removed) toast.success(`Removed ${login} from the allowlist`);
			else toast.info(`${login} was not on the allowlist`);
			removing = null;
		} catch (e) {
			toast.error(`Could not remove ${login}`, { description: describeError(e).message });
		} finally {
			removeBusy = false;
		}
	}

	const loginIssues = $derived(addAllowedUser.fields.login.issues());
	const formIssues = $derived(addAllowedUser.fields.issues());
</script>

<PageHeader
	title="Allowlist & blocklist"
	description="Who may open issues and pull requests. The blocklist wins, then the allowlist; repository owners, members and collaborators are allowed unless blocked."
/>

<div class="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
	<div class="bg-card overflow-hidden rounded-xl border">
		<svelte:boundary>
			{@const list = await users}
			<Table.Root stack>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Login</Table.Head>
						<Table.Head>Added by</Table.Head>
						<Table.Head>Added</Table.Head>
						<Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each list as u (u.login)}
						<Table.Row data-testid="allowed-user">
							<Table.Cell class="font-medium">{u.login}</Table.Cell>
							<Table.Cell class="text-muted-foreground">{u.addedBy === 'seed' ? 'From environment' : (u.addedBy ?? '—')}</Table.Cell>
							<Table.Cell class="text-muted-foreground"><RelativeTime ms={u.addedAt} /></Table.Cell>
							<Table.Cell class="text-right">
								<AdminOnly reason="Only admins can change the allowlist">
									{#snippet children({ disabled })}
										<Button
											variant="ghost"
											size="icon-sm"
											{disabled}
											aria-label="Remove {u.login}"
											onclick={() => (removing = u.login)}
										>
											<TrashIcon />
										</Button>
									{/snippet}
								</AdminOnly>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row class="hover:bg-transparent">
							<Table.Cell colspan={4} class="text-muted-foreground py-10 text-center">
								Nobody is on the allowlist yet.
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#snippet failed(error, reset)}
				<div class="p-4"><ErrorAlert {error} retry={() => { void users.refresh(); reset(); }} /></div>
			{/snippet}
		</svelte:boundary>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Add a login</Card.Title>
			<Card.Description>
				{#if admin}Issues and pull requests opened by this GitHub user will stay open.{:else}Only admins can change the allowlist.{/if}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form
				{...addAllowedUser.enhance(async ({ submit, element }) => {
					try {
						if (await submit()) {
							const r = addAllowedUser.result;
							if (r?.added) toast.success(`Added ${r.user.login} to the allowlist`);
							else if (r) toast.info(`${r.user.login} is already on the allowlist`);
							element.reset();
						}
					} catch (e) {
						toast.error('Could not add the login', { description: describeError(e).message });
					}
				})}
				class="flex flex-col gap-3"
			>
				<div class="grid gap-1.5">
					<Label for="allow-login">GitHub login</Label>
					<Input
						id="allow-login"
						placeholder="octocat"
						autocomplete="off"
						spellcheck={false}
						disabled={!admin}
						{...addAllowedUser.fields.login.as('text')}
					/>
					{#each loginIssues ?? [] as issue, i (i)}
						<p class="text-destructive text-sm">{issue.message}</p>
					{/each}
					{#each formIssues ?? [] as issue, i (i)}
						<p class="text-destructive text-sm">{issue.message}</p>
					{/each}
				</div>
				<AdminOnly reason="Only admins can change the allowlist">
					{#snippet children({ disabled })}
						<Button type="submit" class="w-full" disabled={disabled || addAllowedUser.pending > 0}>
							{#if addAllowedUser.pending}<LoaderCircleIcon class="animate-spin" />{:else}<PlusIcon />{/if}
							Add to allowlist
						</Button>
					{/snippet}
				</AdminOnly>
			</form>
		</Card.Content>
	</Card.Root>
</div>

<div class="mt-10">
	<Blocklist />
</div>

<AlertDialog.Root open={removing !== null} onOpenChange={(open) => { if (!open && !removeBusy) removing = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Remove {removing} from the allowlist?</AlertDialog.Title>
			<AlertDialog.Description>
				New issues and pull requests opened by <strong>{removing}</strong> will be closed automatically unless
				they are a repository owner, member or collaborator. Existing items are not touched.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={removeBusy}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action class={buttonVariants({ variant: 'destructive' })} disabled={removeBusy} onclick={confirmRemove}>
				{#if removeBusy}<LoaderCircleIcon class="animate-spin" />{/if} Remove
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
