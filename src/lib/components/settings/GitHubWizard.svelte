<!--
	First-run wizard (ADR 0160, 0161, 0210): create a GitHub App from a
	manifest. The server stores a nonce and returns the manifest; the browser
	then POSTs a real form to GitHub (`manifest` field, `state` in the URL), as
	GitHub's manifest flow requires. GitHub sends the admin back to
	/settings/github/callback, which stores the app.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { beginGitHubAppManifest } from '$lib/remote/settings.remote';
	import type { SetupStatus } from '$lib/schemas/admins';
	import type { ManifestFormData } from '$lib/schemas/github-app';

	let { setup, webhookUrl }: { setup: SetupStatus | null; webhookUrl: string } = $props();

	const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

	let owner = $state<'user' | 'org'>('user');
	let organization = $state('');
	let name = $state('');
	let busy = $state(false);
	let orgIssue = $state<string | null>(null);
	let nameIssue = $state<string | null>(null);
	let pendingForm = $state<ManifestFormData | null>(null);
	let formEl = $state<HTMLFormElement | null>(null);

	const origin = $derived(setup?.origin ?? null);
	const httpsOk = $derived(origin?.startsWith('https://') ?? false);
	const defaultName = $derived(origin ? `granary-${new URL(origin).host.replace(/[^a-z0-9-]/gi, '-')}`.slice(0, 34) : 'granary');

	async function create() {
		orgIssue = nameIssue = null;
		if (owner === 'org' && !LOGIN_RE.test(organization.trim())) orgIssue = 'Enter the organization’s login, e.g. acme';
		if (name.trim().length > 34) nameIssue = 'At most 34 characters';
		if (orgIssue || nameIssue) return;
		busy = true;
		try {
			pendingForm = await beginGitHubAppManifest({
				...(owner === 'org' ? { organization: organization.trim() } : {}),
				...(name.trim() ? { name: name.trim() } : {})
			});
			await tick();
			formEl?.submit(); // leaves the page for GitHub
		} catch (e) {
			busy = false;
			toast.error('Could not start the GitHub setup', { description: describeError(e).message });
		}
	}
</script>

<div class="grid gap-4" data-testid="github-wizard">
	<Card.Root>
		<Card.Header>
			<Card.Title>1 · Check the public URL</Card.Title>
			<Card.Description>GitHub sends webhooks here and redirects you back here after creating the app.</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-2 text-sm">
			{#if origin}
				<div class="flex flex-wrap items-center gap-2"><span class="text-muted-foreground w-24">Public URL</span><code class="bg-muted rounded px-1.5 py-0.5 break-all">{origin}</code></div>
				<div class="flex flex-wrap items-center gap-2"><span class="text-muted-foreground w-24">Webhooks</span><code class="bg-muted rounded px-1.5 py-0.5 break-all">{webhookUrl}</code><CopyButton text={webhookUrl} /></div>
				{#if !httpsOk}
					<p class="text-muted-foreground text-xs">This is not an https URL. That is fine for local testing; in production GitHub should reach granary over https.</p>
				{/if}
				<p class="text-muted-foreground text-xs">Wrong URL? Change <code>ORIGIN</code> on the server and restart granary before continuing.</p>
			{:else}
				<p>granary does not know its public URL. Set <code>ORIGIN</code> (for example <code>https://granary.example.com</code>) on the server and restart it, then come back here.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>2 · Create the GitHub App</Card.Title>
			<Card.Description>
				GitHub creates an app with everything filled in: webhook URL and secret, the permissions below, and sign-in. Nothing to copy and paste.
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-4 text-sm">
			<ul class="text-muted-foreground grid gap-1">
				<li><span class="text-foreground font-medium">Issues: read &amp; write</span> — to comment on and close issues</li>
				<li><span class="text-foreground font-medium">Metadata: read</span> — required by GitHub for every app</li>
				<li><span class="text-foreground font-medium">Webhook events: issues</span> — granary learns about new issues</li>
			</ul>
			<fieldset class="grid gap-2" disabled={busy}>
				<legend class="mb-1 font-medium">Who should own the app?</legend>
				<label class="flex items-center gap-2"><input type="radio" name="owner" value="user" bind:group={owner} /> My personal GitHub account</label>
				<label class="flex items-center gap-2"><input type="radio" name="owner" value="org" bind:group={owner} /> An organization</label>
				{#if owner === 'org'}
					<div class="grid max-w-sm gap-1.5 pl-6">
						<Label for="gh-org">Organization login</Label>
						<Input id="gh-org" placeholder="acme" autocomplete="off" spellcheck={false} bind:value={organization} aria-invalid={orgIssue ? true : undefined} />
						{#if orgIssue}<p class="text-destructive text-sm">{orgIssue}</p>{/if}
						<p class="text-muted-foreground text-xs">You need to be an owner of the organization.</p>
					</div>
				{/if}
			</fieldset>
			<div class="grid max-w-sm gap-1.5">
				<Label for="gh-name">App name (optional)</Label>
				<Input id="gh-name" placeholder={defaultName} autocomplete="off" spellcheck={false} maxlength={34} bind:value={name} disabled={busy} aria-invalid={nameIssue ? true : undefined} />
				{#if nameIssue}<p class="text-destructive text-sm">{nameIssue}</p>{/if}
				<p class="text-muted-foreground text-xs">Must be unique on GitHub. You can rename it on GitHub later.</p>
			</div>
			<div>
				<AdminOnly reason="Only admins can connect GitHub">
					{#snippet children({ disabled })}
						<Button onclick={create} disabled={disabled || busy || !origin} data-testid="create-github-app">
							{#if busy}<LoaderCircleIcon class="animate-spin" />{:else}<ExternalLinkIcon />{/if}
							Create GitHub App on GitHub
						</Button>
					{/snippet}
				</AdminOnly>
				<p class="text-muted-foreground mt-2 text-xs">You will confirm on GitHub and come straight back here. The link is valid for 10 minutes.</p>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root class="opacity-70">
		<Card.Header>
			<Card.Title>3 · Install it on your repositories</Card.Title>
			<Card.Description>After the app exists, pick the repositories granary should look after. You can change this any time.</Card.Description>
		</Card.Header>
	</Card.Root>
</div>

<!-- The real form GitHub's manifest flow expects: POST `manifest`, `state` in the URL. -->
{#if pendingForm}
	<form bind:this={formEl} method="post" action={pendingForm.postUrl} class="hidden" aria-hidden="true">
		<input type="hidden" name="manifest" value={pendingForm.manifest} />
	</form>
{/if}
