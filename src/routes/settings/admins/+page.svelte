<!-- /settings/admins (ADR 0161, 0210): who may change granary. The last admin cannot be removed. -->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import TableSkeleton from '$lib/components/app/TableSkeleton.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin, shellData } from '$lib/components/app/session';
	import { addAdmin, listAdmins, removeAdmin } from '$lib/remote/settings.remote';

	const admins = listAdmins();
	const admin = $derived(isAdmin());
	const me = $derived(shellData().user?.login.toLowerCase() ?? null);

	const SOURCE_LABEL = { seed: 'from environment', cli: 'from the command line', ui: 'added here' } as const;

	let removing = $state<string | null>(null);
	let removeBusy = $state(false);

	async function confirmRemove() {
		if (!removing) return;
		const login = removing;
		removeBusy = true;
		try {
			const r = await removeAdmin({ login });
			if (r.removed) toast.success(`${login} is no longer an admin`);
			else toast.info(`${login} was not an admin`);
			removing = null;
		} catch (e) {
			toast.error(`Could not remove ${login}`, { description: describeError(e).message });
		} finally {
			removeBusy = false;
		}
	}

	const loginIssues = $derived(addAdmin.fields.login.issues());
	const formIssues = $derived(addAdmin.fields.issues());
</script>

<PageHeader title="Admins" description="Admins can sign in, connect GitHub, change the allowlist and configure backups. Everyone else can only look." />

<div class="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
	<div class="bg-card overflow-hidden rounded-xl border">
		<svelte:boundary>
			{@const list = await admins}
			<Table.Root stack>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>GitHub login</Table.Head>
						<Table.Head>Source</Table.Head>
						<Table.Head>Added</Table.Head>
						<Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each list as a (a.login)}
						<Table.Row data-testid="admin-row">
							<Table.Cell class="font-medium">
								{a.login}
								{#if me === a.login.toLowerCase()}<Badge variant="secondary" class="ml-1.5">you</Badge>{/if}
							</Table.Cell>
							<Table.Cell class="text-muted-foreground">{SOURCE_LABEL[a.source]}{#if a.source !== 'seed'}{' · by '}{a.addedBy}{/if}</Table.Cell>
							<Table.Cell class="text-muted-foreground"><RelativeTime ms={a.addedAt} /></Table.Cell>
							<Table.Cell class="text-right">
								<AdminOnly reason="Only admins can remove admins">
									{#snippet children({ disabled })}
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={disabled || list.length <= 1}
											title={list.length <= 1 ? 'The last admin cannot be removed' : undefined}
											aria-label="Remove {a.login}"
											onclick={() => (removing = a.login)}
										>
											<TrashIcon />
										</Button>
									{/snippet}
								</AdminOnly>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#snippet pending()}
				<TableSkeleton columns={4} rows={3} />
			{/snippet}
			{#snippet failed(error, reset)}
				<div class="p-4"><ErrorAlert {error} retry={() => { void admins.refresh(); reset(); }} /></div>
			{/snippet}
		</svelte:boundary>
	</div>

	<div class="grid gap-4">
		<Card.Root>
			<Card.Header>
				<Card.Title>Add an admin</Card.Title>
				<Card.Description>{#if admin}They sign in with GitHub, or with a login link.{:else}Only admins can add admins.{/if}</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					{...addAdmin.enhance(async ({ submit, element }) => {
						try {
							if (await submit()) {
								const r = addAdmin.result;
								if (r?.added) toast.success(`${r.admin.login} is now an admin`);
								else if (r) toast.info(`${r.admin.login} is already an admin`);
								element.reset();
							}
						} catch (e) {
							toast.error('Could not add the admin', { description: describeError(e).message });
						}
					})}
					class="flex flex-col gap-3"
				>
					<div class="grid gap-1.5">
						<Label for="admin-login">GitHub login</Label>
						<Input id="admin-login" placeholder="octocat" autocomplete="off" spellcheck={false} disabled={!admin} {...addAdmin.fields.login.as('text')} />
						{#each loginIssues ?? [] as issue, i (i)}<p class="text-destructive text-sm">{issue.message}</p>{/each}
						{#each formIssues ?? [] as issue, i (i)}<p class="text-destructive text-sm">{issue.message}</p>{/each}
					</div>
					<AdminOnly reason="Only admins can add admins">
						{#snippet children({ disabled })}
							<Button type="submit" class="w-full" disabled={disabled || addAdmin.pending > 0}>
								{#if addAdmin.pending}<LoaderCircleIcon class="animate-spin" />{:else}<PlusIcon />{/if}
								Add admin
							</Button>
						{/snippet}
					</AdminOnly>
				</form>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title>From the server</Card.Title>
				<Card.Description>Useful before anyone can sign in.</Card.Description>
			</Card.Header>
			<Card.Content class="text-muted-foreground grid gap-1.5 text-sm">
				<code class="bg-muted text-foreground rounded px-1.5 py-0.5">granary admin add &lt;login&gt;</code>
				<code class="bg-muted text-foreground rounded px-1.5 py-0.5">granary login-link &lt;login&gt;</code>
			</Card.Content>
		</Card.Root>
	</div>
</div>

<AlertDialog.Root open={removing !== null} onOpenChange={(open) => { if (!open && !removeBusy) removing = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Remove {removing} as admin?</AlertDialog.Title>
			<AlertDialog.Description>
				{#if removing?.toLowerCase() === me}You will lose admin rights yourself and can no longer change settings.{:else}<strong>{removing}</strong> will no longer be able to sign in or change settings.{/if}
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
