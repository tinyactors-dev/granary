<!--
	/settings/login-links (ADR 0161, 0210): create a one-time sign-in link for
	an admin. The URL exists only in this response; granary stores a hash.
	The same thing from the server: `granary login-link <login>`.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import LinkIcon from '@lucide/svelte/icons/link';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { toast } from 'svelte-sonner';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import NativeSelect from '$lib/components/ops/NativeSelect.svelte';
	import { absoluteTime, describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';
	import { LOGIN_LINK_TTL_CHOICES } from '$lib/components/settings/nav';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import { createLoginLink, listAdmins, listLoginLinks, revokeLoginLink } from '$lib/remote/settings.remote';
	import type { CreatedLoginLink, LoginLinkState } from '$lib/schemas/admins';

	let revoking = $state<string | null>(null);
	async function revoke(id: string) {
		revoking = id;
		try {
			const r = await revokeLoginLink({ id });
			if (r.revoked) toast.success('Link revoked');
			else toast.info('That link could no longer be used anyway');
		} catch (e) {
			toast.error('Could not revoke', { description: describeError(e).message });
		} finally {
			revoking = null;
		}
	}
	const STATE_VARIANT: Record<LoginLinkState, 'default' | 'secondary' | 'outline' | 'destructive'> = { valid: 'default', used: 'secondary', expired: 'outline', revoked: 'destructive' };

	const admins = listAdmins();
	const admin = $derived(isAdmin());
	/** Kept only in this component: gone after navigation. */
	let created = $state<CreatedLoginLink | null>(null);

	const loginIssues = $derived(createLoginLink.fields.login.issues());
	const ttlIssues = $derived(createLoginLink.fields.ttlMinutes.issues());
	const formIssues = $derived(createLoginLink.fields.issues());
</script>

<PageHeader title="Login links" description="A one-time sign-in link for an admin — for the first sign-in, or when GitHub sign-in is not available." />

<div class="grid items-start gap-4 lg:grid-cols-[22rem_1fr]">
	<Card.Root>
		<Card.Header>
			<Card.Title>Create a link</Card.Title>
			<Card.Description>Single use. It shows a confirmation page first, so chat link previews don’t use it up.</Card.Description>
		</Card.Header>
		<Card.Content>
			<svelte:boundary>
				{@const list = await admins}
				<form
					{...createLoginLink.enhance(async ({ submit }) => {
						try {
							if (await submit()) {
								created = createLoginLink.result ?? null;
								if (created) toast.success(`Login link for ${created.login} created`);
							}
						} catch (e) {
							toast.error('Could not create the link', { description: describeError(e).message });
						}
					})}
					class="flex flex-col gap-3"
				>
					<div class="grid gap-1.5">
						<Label for="link-login">For admin</Label>
						<NativeSelect id="link-login" disabled={!admin} {...createLoginLink.fields.login.as('select')}>
							{#each list as a (a.login)}<option value={a.login}>{a.login}</option>{/each}
						</NativeSelect>
						{#each loginIssues ?? [] as issue, i (i)}<p class="text-destructive text-sm">{issue.message}</p>{/each}
					</div>
					<div class="grid gap-1.5">
						<Label for="link-ttl">Valid for</Label>
						<NativeSelect id="link-ttl" disabled={!admin} {...createLoginLink.fields.ttlMinutes.as('select')}>
							{#each LOGIN_LINK_TTL_CHOICES as c (c.minutes)}<option value={String(c.minutes)}>{c.label}</option>{/each}
						</NativeSelect>
						{#each ttlIssues ?? [] as issue, i (i)}<p class="text-destructive text-sm">{issue.message}</p>{/each}
					</div>
					{#each formIssues ?? [] as issue, i (i)}<p class="text-destructive text-sm">{issue.message}</p>{/each}
					<AdminOnly reason="Only admins can create login links">
						{#snippet children({ disabled })}
							<Button type="submit" class="w-full" disabled={disabled || createLoginLink.pending > 0} data-testid="create-login-link">
								{#if createLoginLink.pending}<LoaderCircleIcon class="animate-spin" />{:else}<LinkIcon />{/if}
								Create link
							</Button>
						{/snippet}
					</AdminOnly>
				</form>
				{#snippet failed(error, reset)}
					<ErrorAlert {error} retry={() => { void admins.refresh(); reset(); }} />
				{/snippet}
			</svelte:boundary>
		</Card.Content>
	</Card.Root>

	<div class="grid gap-4">
		{#if created}
			<Alert.Root data-testid="login-link-created">
				<KeyRoundIcon />
				<Alert.Title>Link for {created.login} — shown only once</Alert.Title>
				<Alert.Description class="grid gap-2">
					<div class="flex flex-wrap items-center gap-2">
						<code class="bg-muted text-foreground rounded px-1.5 py-0.5 text-xs break-all" data-testid="login-link-url">{created.url}</code>
						<CopyButton text={created.url} />
					</div>
					<span>Valid until {absoluteTime(created.expiresAt)}. Anyone with this link can sign in as {created.login} once — send it privately.</span>
				</Alert.Description>
			</Alert.Root>
		{/if}
		<Card.Root>
			<Card.Header>
				<Card.Title>From the server</Card.Title>
				<Card.Description>When nobody can sign in yet, create the first link over SSH.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-1.5 text-sm">
				<code class="bg-muted rounded px-1.5 py-0.5">granary admin add &lt;your-login&gt;</code>
				<code class="bg-muted rounded px-1.5 py-0.5">granary login-link &lt;your-login&gt; --ttl 15m</code>
			</Card.Content>
		</Card.Root>
		{#if admin}
			<Card.Root data-testid="login-link-list">
				<Card.Header>
					<Card.Title>Recent links</Card.Title>
					<Card.Description>Tokens are never shown again; revoke a link you no longer trust.</Card.Description>
				</Card.Header>
				<Card.Content>
					<svelte:boundary>
						{@const links = await listLoginLinks()}
						{#if links.length === 0}
							<p class="text-muted-foreground text-sm">No login links yet.</p>
						{:else}
							<Table.Root stack>
								<Table.Header>
									<Table.Row><Table.Head>For</Table.Head><Table.Head>State</Table.Head><Table.Head>Created</Table.Head><Table.Head>Expires</Table.Head><Table.Head></Table.Head></Table.Row>
								</Table.Header>
								<Table.Body>
									{#each links as l (l.id)}
										<Table.Row>
											<Table.Cell class="font-medium">{l.login}</Table.Cell>
											<Table.Cell><Badge variant={STATE_VARIANT[l.state]}>{l.state}</Badge></Table.Cell>
											<Table.Cell class="text-muted-foreground text-xs"><RelativeTime ms={l.createdAt} /> by {l.createdBy}</Table.Cell>
											<Table.Cell class="text-muted-foreground text-xs"><RelativeTime ms={l.expiresAt} /></Table.Cell>
											<Table.Cell class="text-right">
												{#if l.state === 'valid'}
													<Button size="sm" variant="outline" disabled={revoking === l.id} onclick={() => revoke(l.id)} data-testid="revoke-login-link">Revoke</Button>
												{/if}
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{/if}
						{#snippet failed(e)}<ErrorAlert error={e} />{/snippet}
					</svelte:boundary>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</div>
