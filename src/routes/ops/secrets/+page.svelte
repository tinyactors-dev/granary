<script lang="ts">
	import type { SecretMeta } from '$lib/ops/contract';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { toast } from 'svelte-sonner';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import SecretForm from '$lib/components/ops/SecretForm.svelte';
	import { SECRET_KIND_LABEL } from '$lib/components/ops/format';
	import { deleteOpsSecret, getOpsKeyStatus, listOpsSecrets } from '$lib/remote/ops.remote';

	const secrets = listOpsSecrets();
	const keys = getOpsKeyStatus();
	let replacing = $state<SecretMeta | null>(null);
	let deleting = $state<SecretMeta | null>(null);

	const usedHref = (u: { area: string; id: string }) =>
		u.area === 'destination' ? `/ops/destinations/${u.id}` : u.area === 'sink' ? `/ops/telemetry/${u.id}` : null;

	async function remove() {
		if (!deleting) return;
		const s = deleting;
		try {
			await deleteOpsSecret({ id: s.id });
			toast.success(`Deleted "${s.name}"`);
		} catch (e) {
			toast.error('Could not delete', { description: describeError(e).message });
		} finally {
			deleting = null;
		}
	}
</script>

<PageHeader title="Secrets" description="Credentials for destinations and telemetry. Values are encrypted with the master key and never shown again — only a short fingerprint." />

<div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
	<div class="grid min-w-0 gap-4">
		<svelte:boundary>
			{@const k = await keys}
			<Card.Root data-testid="key-status">
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						Master key
						<StateBadge state={k.master === 'ok' ? 'configured' : k.master === 'missing' ? 'missing' : 'dev-generated'} tone={k.master === 'ok' ? 'success' : k.master === 'missing' ? 'warning' : 'info'} />
					</Card.Title>
					<Card.Description>
						{#if k.master === 'missing'}
							Ops runs degraded: configuration is readable, but backups and anything needing a secret wait until GRANARY_MASTER_KEY is set.
						{:else if k.master === 'dev-generated'}
							A throwaway key generated for development. Backups made with it are useless elsewhere.
						{:else}
							Key <code>{k.kekId}</code>, from GRANARY_MASTER_KEY or the data directory's master key file.
						{/if}
					</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-3 text-sm">
					{#if k.previousKekPresent || k.secretsOnPreviousKek}
						<p>Rotation in progress: {k.secretsOnPreviousKek} secret{k.secretsOnPreviousKek === 1 ? ' is' : 's are'} still wrapped by the previous key; they are re-wrapped at the next start.</p>
					{/if}
					{#if k.backupsOnMissingKek}
						<p>{k.backupsOnMissingKek} retained backup{k.backupsOnMissingKek === 1 ? ' uses' : 's use'} a key that is no longer configured and can't be restored. Keep that key in GRANARY_MASTER_KEY_PREVIOUS until retention prunes them.</p>
					{/if}
					<details class="text-muted-foreground">
						<summary class="text-foreground cursor-pointer">How to rotate the master key</summary>
						<ol class="mt-2 list-decimal space-y-1 pl-5">
							<li>Generate a new key: <code>openssl rand -base64 32</code>.</li>
							<li>In your password manager and the service environment, move the current value to <code>GRANARY_MASTER_KEY_PREVIOUS</code> and store the new one as <code>GRANARY_MASTER_KEY</code>.</li>
							<li>Restart granary: secrets are re-wrapped automatically; new backups use the new key.</li>
							<li>Keep the previous key until no retained backup needs it (this card shows the count), then remove it.</li>
						</ol>
					</details>
				</Card.Content>
			</Card.Root>
			{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
		</svelte:boundary>

		<div class="bg-card overflow-x-auto rounded-xl border">
			<svelte:boundary>
				<Table.Root stack>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Secret</Table.Head>
							<Table.Head>Fingerprint</Table.Head>
							<Table.Head>Used by</Table.Head>
							<Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each await secrets as s (s.id)}
							<Table.Row data-testid="ops-secret">
								<Table.Cell>
									<div class="font-medium">{s.name}</div>
									<span class="text-muted-foreground text-xs">{SECRET_KIND_LABEL[s.kind]}{s.kekCurrent ? '' : ' · on previous key'}</span>
									<div class="text-muted-foreground text-xs">
										{#if s.lastUsedAt}used <RelativeTime ms={s.lastUsedAt} /> · {s.lastUsedOk ? 'worked' : 'rejected'}{:else}never used{/if}
									</div>
								</Table.Cell>
								<Table.Cell><code class="text-xs">{s.fingerprint}</code></Table.Cell>
								<Table.Cell class="text-sm">
									{#each s.usedBy as u (u.area + u.id)}
										{@const href = usedHref(u)}
										<div>{#if href}<a class="hover:underline" {href}>{u.area} {u.id}</a>{:else}{u.area} {u.id}{/if}</div>
									{:else}<span class="text-muted-foreground">unused</span>{/each}
								</Table.Cell>
								<Table.Cell>
									<AdminOnly reason="Only admins can change secrets">
										{#snippet children({ disabled })}
											<div class="flex justify-end gap-1">
												<Button variant="ghost" size="icon-sm" {disabled} aria-label="Replace {s.name}" onclick={() => (replacing = s)}><RefreshCwIcon /></Button>
												<Button variant="ghost" size="icon-sm" {disabled} aria-label="Delete {s.name}" onclick={() => (deleting = s)}><TrashIcon /></Button>
											</div>
										{/snippet}
									</AdminOnly>
								</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row class="hover:bg-transparent"><Table.Cell colspan={4} class="text-muted-foreground py-10 text-center">No secrets stored.</Table.Cell></Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#snippet failed(error)}<div class="p-4"><ErrorAlert {error} /></div>{/snippet}
			</svelte:boundary>
		</div>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Store a secret</Card.Title>
			<Card.Description>Usually you'll paste secrets straight into a destination or sink form instead.</Card.Description>
		</Card.Header>
		<Card.Content><SecretForm /></Card.Content>
	</Card.Root>
</div>

<Dialog.Root open={replacing !== null} onOpenChange={(o) => { if (!o) replacing = null; }}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Replace "{replacing?.name}"</Dialog.Title>
			<Dialog.Description>Everything that uses it picks up the new value on its next use. The old value is gone for good.</Dialog.Description>
		</Dialog.Header>
		{#if replacing}<SecretForm secret={replacing} ondone={() => (replacing = null)} />{/if}
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={deleting !== null} onOpenChange={(o) => { if (!o) deleting = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete "{deleting?.name}"?</AlertDialog.Title>
			<AlertDialog.Description>{deleting?.usedBy.length ? 'It is still in use — change those first.' : 'Nothing uses it.'} This can't be undone.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action class={buttonVariants({ variant: 'destructive' })} onclick={remove}>Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
