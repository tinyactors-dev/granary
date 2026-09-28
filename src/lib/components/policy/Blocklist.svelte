<!--
	Blocklist (ADR 0260): logins whose issues are always closed — even when
	they are allowlisted or an OWNER/MEMBER/COLLABORATOR. Entries may expire
	("block me for 1 hour" lets an admin test the close flow end to end).
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import BanIcon from '@lucide/svelte/icons/ban';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import { blockMe, blockUser, listBlockedUsers, unblockUser } from '$lib/remote/allowlist.remote';
	import NativeSelect from '$lib/components/ops/NativeSelect.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin, shellData } from '$lib/components/app/session';

	const blocked = listBlockedUsers();
	const admin = $derived(isAdmin());
	const me = $derived(shellData().user?.login ?? null);

	let removing = $state<string | null>(null);
	let removeBusy = $state(false);
	let blockMeBusy = $state(false);

	/** The login being typed, to warn before blocking yourself. */
	let typed = $state('');
	const typedIsMe = $derived(me !== null && typed.trim().toLowerCase() === me.toLowerCase());

	const loginIssues = $derived(blockUser.fields.login.issues());
	const formIssues = $derived(blockUser.fields.issues());

	async function confirmRemove() {
		if (!removing) return;
		const login = removing;
		removeBusy = true;
		try {
			const r = await unblockUser({ login });
			if (r.removed) toast.success(`Unblocked ${r.login}`);
			else toast.info(`${login} was not blocked`);
			removing = null;
		} catch (e) {
			toast.error(`Could not unblock ${login}`, { description: describeError(e).message });
		} finally {
			removeBusy = false;
		}
	}

	async function blockMyself() {
		blockMeBusy = true;
		try {
			const r = await blockMe();
			toast.success(`You (${r.user.login}) are blocked for 1 hour`, {
				description: 'Open an issue or pull request in a guarded repository: granary will close it. Unblock yourself here when done.'
			});
		} catch (e) {
			toast.error('Could not block you', { description: describeError(e).message });
		} finally {
			blockMeBusy = false;
		}
	}
</script>

<section id="blocklist" class="grid scroll-mt-20 gap-3" aria-labelledby="blocklist-title">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 id="blocklist-title" class="text-lg font-semibold tracking-tight">Blocklist</h2>
			<p class="text-muted-foreground text-sm">
				Issues and pull requests opened by these logins are always closed — even if they are on the
				allowlist or a repository owner, member or collaborator. The blocklist wins over the allowlist,
				and the allowlist over repository roles.
			</p>
		</div>
		<AdminOnly reason="Only admins can change the blocklist">
			{#snippet children({ disabled })}
				<Button variant="outline" size="sm" {disabled} onclick={blockMyself} data-testid="block-me">
					{#if blockMeBusy}<LoaderCircleIcon class="animate-spin" />{:else}<FlaskConicalIcon />{/if}
					Block me for 1 hour
				</Button>
			{/snippet}
		</AdminOnly>
	</div>

	<div class="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
		<div class="bg-card overflow-hidden rounded-xl border">
			<svelte:boundary>
				{@const list = await blocked}
				<Table.Root stack>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Login</Table.Head>
							<Table.Head>State</Table.Head>
							<Table.Head>Until</Table.Head>
							<Table.Head>Note</Table.Head>
							<Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each list as b (b.login)}
							<Table.Row data-testid="blocked-user" data-active={b.active}>
								<Table.Cell class="font-medium">
									{b.login}
									{#if b.isAdmin && b.active}<span class="text-muted-foreground block text-xs">An admin: their own issues and pull requests are closed too</span>{/if}
								</Table.Cell>
								<Table.Cell><StateBadge state={b.active ? 'blocked' : 'expired'} tone={b.active ? 'danger' : 'muted'} /></Table.Cell>
								<Table.Cell class="text-muted-foreground">
									{#if b.expiresAt === null}until removed{:else}<RelativeTime ms={b.expiresAt} />{/if}
								</Table.Cell>
								<Table.Cell class="text-muted-foreground max-w-48 truncate" title={b.note ?? ''}>{b.note ?? '—'}</Table.Cell>
								<Table.Cell class="text-right">
									<AdminOnly reason="Only admins can change the blocklist">
										{#snippet children({ disabled })}
											<Button variant="ghost" size="icon-sm" {disabled} aria-label="Unblock {b.login}" onclick={() => (removing = b.login)}>
												<TrashIcon />
											</Button>
										{/snippet}
									</AdminOnly>
								</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row class="hover:bg-transparent">
								<Table.Cell colspan={5} class="text-muted-foreground py-10 text-center">Nobody is blocked.</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#snippet failed(error, reset)}
					<div class="p-4"><ErrorAlert {error} retry={() => { void blocked.refresh(); reset(); }} /></div>
				{/snippet}
			</svelte:boundary>
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Block a login</Card.Title>
				<Card.Description>
					{#if admin}Their issues and pull requests will be closed with the usual comment.{:else}Only admins can change the blocklist.{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					{...blockUser.enhance(async ({ submit, element }) => {
						try {
							if (await submit()) {
								const r = blockUser.result;
								if (r) toast.success(`${r.added ? 'Blocked' : 'Updated block for'} ${r.user.login}`);
								element.reset();
								typed = '';
							}
						} catch (e) {
							toast.error('Could not block the login', { description: describeError(e).message });
						}
					})}
					class="flex flex-col gap-3"
				>
					<div class="grid gap-1.5">
						<Label for="block-login">GitHub login</Label>
						<Input
							id="block-login"
							placeholder="octocat"
							autocomplete="off"
							spellcheck={false}
							disabled={!admin}
							{...blockUser.fields.login.as('text')}
							oninput={(e) => (typed = (e.currentTarget as HTMLInputElement).value)}
						/>
						{#each loginIssues ?? [] as issue, i (i)}<p class="text-destructive text-sm">{issue.message}</p>{/each}
					</div>
					<div class="grid gap-1.5">
						<Label for="block-duration">For</Label>
						<NativeSelect id="block-duration" disabled={!admin} {...blockUser.fields.duration.as('select', '1h')}>
							<option value="1h">1 hour</option>
							<option value="1d">1 day</option>
							<option value="7d">7 days</option>
							<option value="forever">Until removed</option>
						</NativeSelect>
					</div>
					<div class="grid gap-1.5">
						<Label for="block-note">Note (optional)</Label>
						<Input id="block-note" placeholder="e.g. self-test, spam" autocomplete="off" disabled={!admin} {...blockUser.fields.note.as('text')} />
					</div>
					{#if typedIsMe}
						<Alert.Root variant="destructive" data-testid="block-self-warning">
							<TriangleAlertIcon />
							<Alert.Title>This is you</Alert.Title>
							<Alert.Description>Issues and pull requests you open will be closed while the block lasts — useful for testing, easy to forget.</Alert.Description>
						</Alert.Root>
					{/if}
					{#each formIssues ?? [] as issue, i (i)}<p class="text-destructive text-sm">{issue.message}</p>{/each}
					<AdminOnly reason="Only admins can change the blocklist">
						{#snippet children({ disabled })}
							<Button type="submit" variant="destructive" class="w-full" disabled={disabled || blockUser.pending > 0}>
								{#if blockUser.pending}<LoaderCircleIcon class="animate-spin" />{:else}<BanIcon />{/if}
								Block
							</Button>
						{/snippet}
					</AdminOnly>
				</form>
			</Card.Content>
		</Card.Root>
	</div>
</section>

<AlertDialog.Root open={removing !== null} onOpenChange={(open) => { if (!open && !removeBusy) removing = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Unblock {removing}?</AlertDialog.Title>
			<AlertDialog.Description>
				New issues and pull requests by <strong>{removing}</strong> are decided by the allowlist and their
				repository role again. Items already closed stay closed.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={removeBusy}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action class={buttonVariants({ variant: 'default' })} disabled={removeBusy} onclick={confirmRemove}>
				{#if removeBusy}<LoaderCircleIcon class="animate-spin" />{/if} Unblock
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
