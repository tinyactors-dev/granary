<!--
	/settings/github (ADR 0160, 0161, 0210): the setup wizard until GitHub is
	connected, the connection and repositories afterwards. The callback and
	post-install routes redirect back here with `?created=1`,
	`?installed=1` or `?error=<message>`.
-->
<script lang="ts">
	import { page } from '$app/state';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import PartyPopperIcon from '@lucide/svelte/icons/party-popper';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import GitHubWizard from '$lib/components/settings/GitHubWizard.svelte';
	import GitHubConnection from '$lib/components/settings/GitHubConnection.svelte';
	import { getGitHubStatus, getSetupStatus } from '$lib/remote/settings.remote';

	const status = getGitHubStatus();
	const setup = getSetupStatus();

	const created = $derived(page.url.searchParams.has('created'));
	const installed = $derived(page.url.searchParams.has('installed'));
	const problem = $derived(page.url.searchParams.get('error'));
</script>

<PageHeader title="GitHub" description="How granary talks to GitHub, and which repositories it looks after." />

{#if problem}
	<Alert.Root variant="destructive" data-testid="github-error">
		<CircleAlertIcon />
		<Alert.Title>GitHub setup did not finish</Alert.Title>
		<Alert.Description>{problem} You can start again below.</Alert.Description>
	</Alert.Root>
{:else if created}
	<Alert.Root data-testid="github-created">
		<PartyPopperIcon />
		<Alert.Title>The GitHub App exists</Alert.Title>
		<Alert.Description>Last step: install it on the repositories granary should look after.</Alert.Description>
	</Alert.Root>
{:else if installed}
	<Alert.Root data-testid="github-installed">
		<PartyPopperIcon />
		<Alert.Title>Installed</Alert.Title>
		<Alert.Description>granary now checks new issues in the repositories below.</Alert.Description>
	</Alert.Root>
{/if}

<svelte:boundary>
	{@const s = await status}
	{#if s.mode === 'none'}
		<GitHubWizard setup={await setup} webhookUrl={s.webhookUrl} />
	{:else}
		<GitHubConnection status={s} />
	{/if}
	{#snippet pending()}
		<Skeleton class="h-72 rounded-xl" />
	{/snippet}
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void status.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
