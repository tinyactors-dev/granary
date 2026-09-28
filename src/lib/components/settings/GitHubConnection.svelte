<!--
	A connected GitHub (ADR 0160, 0162, 0210): the app, whether its credentials
	work, missed-webhook catch-up, and the installations with per-repository
	switches for issues and pull requests (ADR 0280). Pull requests need the
	app's `pull_requests: write` permission, accepted on each installation
	(ADR 0281); until then the pull request switch is disabled and a card says
	how to grant it. Disabled repositories still send webhooks; granary records
	them as ignored.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import CheckCircleIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import { toast } from 'svelte-sonner';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import GitHubLogoCard from './GitHubLogoCard.svelte';
	import { isAdmin } from '$lib/components/app/session';
	import { disconnectGitHub, refreshGitHubInstallations, setRepoEnabled } from '$lib/remote/settings.remote';
	import type { GitHubStatus, RepoSummary, RepoSwitch } from '$lib/schemas/github-app';

	/** `justCreated`: the manifest callback just redirected here (`?created=1`); highlights the logo step. */
	let { status, justCreated = false }: { status: GitHubStatus; justCreated?: boolean } = $props();

	let refreshing = $state(false);
	let confirmDisconnect = $state(false);
	let disconnecting = $state(false);

	async function disconnect() {
		disconnecting = true;
		try {
			await disconnectGitHub();
			toast.success('GitHub disconnected. granary no longer acts on GitHub.');
			confirmDisconnect = false;
		} catch (e) {
			toast.error('Could not disconnect', { description: describeError(e).message });
		} finally {
			disconnecting = false;
		}
	}
	let toggling = $state<string | null>(null);

	const guarded = $derived(status.installations.reduce((n, i) => n + i.repos.filter((r) => r.enabled).length, 0));
	const guardedPrs = $derived(status.installations.reduce((n, i) => n + i.repos.filter((r) => r.prsEnabled && r.prAccess).length, 0));
	const pr = $derived(status.pullRequests);
	const web = $derived(status.app ? new URL(status.app.htmlUrl).origin : 'https://github.com');
	const installationSettingsUrl = (inst: { installationId: number; account: string }, accountType: string | undefined) =>
		accountType === 'Organization'
			? `${web}/organizations/${encodeURIComponent(inst.account)}/settings/installations/${inst.installationId}`
			: `${web}/settings/installations/${inst.installationId}`;

	async function refresh() {
		refreshing = true;
		try {
			const list = await refreshGitHubInstallations();
			toast.success('Installations refreshed', { description: `${list.length} ${list.length === 1 ? 'installation' : 'installations'} found on GitHub` });
		} catch (e) {
			toast.error('Could not refresh from GitHub', { description: describeError(e).message });
		} finally {
			refreshing = false;
		}
	}

	async function toggle(repo: RepoSummary, enabled: boolean, kind: RepoSwitch = 'issues') {
		toggling = `${repo.repoId}:${kind}`;
		const what = kind === 'pull_requests' ? 'pull requests in' : 'issues in';
		try {
			await setRepoEnabled({ repoId: repo.repoId, enabled, kind });
			toast.success(enabled ? `Guarding ${what} ${repo.fullName}` : `No longer guarding ${what} ${repo.fullName}`);
		} catch (e) {
			toast.error(`Could not change ${repo.fullName}`, { description: describeError(e).message });
		} finally {
			toggling = null;
		}
	}
</script>

<div class="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
	<div class="grid gap-4">
		{#if pr && !pr.ready}
			<Card.Root class="border-amber-500/40" data-testid="github-pr-access">
				<Card.Header>
					<Card.Title class="flex items-center gap-2"><CircleAlertIcon class="size-4 text-amber-600 dark:text-amber-400" /> Grant pull request access</Card.Title>
					<Card.Description>
						granary can also close pull requests from people who aren't on the allowlist, but this app can't touch pull requests yet. Until it can, pull requests are left alone.
					</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-3 text-sm">
					<ol class="grid list-decimal gap-2 pl-5">
						<li class={pr.appPermission && pr.appEvent ? 'text-muted-foreground line-through' : ''}>
							Open the <a class="underline" href={pr.permissionsUrl} target="_blank" rel="noreferrer">app's permissions on GitHub</a>, set
							<strong>Repository permissions → Pull requests</strong> to <strong>Read and write</strong>, tick
							<strong>Subscribe to events → Pull request</strong>, and <strong>Save changes</strong>.
						</li>
						<li class={pr.pendingInstallations.length === 0 ? 'text-muted-foreground line-through' : ''}>
							Accept the new permissions on each installation (GitHub asks the account owner; it also emails them):
							{#if pr.pendingInstallations.length}
								<ul class="mt-1 grid gap-1">
									{#each pr.pendingInstallations as p (p.installationId)}
										{@const inst = status.installations.find((i) => i.installationId === p.installationId)}
										<li>
											<a class="underline" href={installationSettingsUrl(p, inst?.accountType)} target="_blank" rel="noreferrer">{p.account}</a>
											<span class="text-muted-foreground">→ “Review request” → Accept new permissions</span>
										</li>
									{/each}
								</ul>
							{/if}
						</li>
						<li>Come back and press <strong>Refresh</strong>. The pull request switches unlock per repository.</li>
					</ol>
				</Card.Content>
			</Card.Root>
		{/if}
		{#if status.app && !status.app.logoHintDismissed && isAdmin()}
			<GitHubLogoCard settingsUrl={status.app.settingsUrl} highlight={justCreated} />
		{/if}
		<Card.Root data-testid="github-installations">
			<Card.Header class="flex flex-row items-start justify-between gap-3">
				<div class="grid gap-1.5">
					<Card.Title>Repositories</Card.Title>
					<Card.Description>
						Issues guarded in {guarded}, pull requests in {guardedPrs}. New issues and pull requests in a guarded repository are checked against the allowlist; the others are left alone.
					</Card.Description>
				</div>
				<div class="flex flex-wrap gap-2">
					{#if status.app}
						<Button variant="outline" size="sm" href={status.app.installUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon /> Add repositories</Button>
					{/if}
					<AdminOnly reason="Only admins can refresh from GitHub">
						{#snippet children({ disabled })}
							<Button variant="outline" size="sm" onclick={refresh} disabled={disabled || refreshing} data-testid="refresh-installations">
								<RefreshCwIcon class={refreshing ? 'animate-spin' : ''} /> Refresh
							</Button>
						{/snippet}
					</AdminOnly>
				</div>
			</Card.Header>
			<Card.Content class="grid gap-4">
				{#each status.installations as inst (inst.installationId)}
					<div class="overflow-hidden rounded-lg border" data-testid="github-installation">
						<div class="bg-muted/40 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
							<span class="font-medium">{inst.account}</span>
							<Badge variant="outline">{inst.accountType}</Badge>
							<span class="text-muted-foreground">{inst.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}</span>
							{#if inst.suspended}<Badge variant="destructive">suspended</Badge>{/if}
							<span class="text-muted-foreground ml-auto text-xs">synced <RelativeTime ms={inst.syncedAt} /></span>
						</div>
						<Table.Root stack>
							<Table.Body>
								{#each inst.repos as repo (repo.repoId)}
									<Table.Row data-testid="github-repo">
										<Table.Cell class="font-medium">{repo.fullName}</Table.Cell>
										<Table.Cell class="w-0 text-right">
											<AdminOnly reason="Only admins can change which repositories are guarded">
												{#snippet children({ disabled })}
													<label class="flex items-center justify-end gap-2 text-sm whitespace-nowrap">
														<span class="text-muted-foreground">Issues</span>
														<Switch
															checked={repo.enabled}
															disabled={disabled || toggling === `${repo.repoId}:issues` || inst.suspended}
															aria-label="Guard issues in {repo.fullName}"
															data-testid="repo-switch-issues"
															onCheckedChange={(v) => toggle(repo, v, 'issues')}
														/>
													</label>
												{/snippet}
											</AdminOnly>
										</Table.Cell>
										<Table.Cell class="w-0 text-right">
											<AdminOnly reason={repo.prAccess ? 'Only admins can change which repositories are guarded' : 'The app has no pull request access on this installation yet'}>
												{#snippet children({ disabled })}
													<label class="flex items-center justify-end gap-2 text-sm whitespace-nowrap" title={repo.prAccess ? undefined : 'Grant the app pull request access first (see above)'}>
														<span class="text-muted-foreground">Pull requests{repo.prAccess ? '' : ' (no access)'}</span>
														<Switch
															checked={repo.prsEnabled && repo.prAccess}
															disabled={disabled || !repo.prAccess || toggling === `${repo.repoId}:pull_requests` || inst.suspended}
															aria-label="Guard pull requests in {repo.fullName}"
															data-testid="repo-switch-prs"
															onCheckedChange={(v) => toggle(repo, v, 'pull_requests')}
														/>
													</label>
												{/snippet}
											</AdminOnly>
										</Table.Cell>
									</Table.Row>
								{:else}
									<Table.Row class="hover:bg-transparent"><Table.Cell colspan={3} class="text-muted-foreground py-6 text-center text-sm">No repositories in this installation yet.</Table.Cell></Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				{:else}
					<div class="text-muted-foreground grid gap-2 py-6 text-center text-sm">
						<p>The app is not installed anywhere yet.</p>
						{#if status.app}
							<div><Button href={status.app.installUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon /> Install on GitHub</Button></div>
							<p class="text-xs">Then come back and press Refresh (granary also notices new installations by itself).</p>
						{/if}
					</div>
				{/each}
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid gap-4">
		<Card.Root data-testid="github-app">
			<Card.Header>
				<Card.Title>{status.mode === 'app' ? 'GitHub App' : 'Token connection'}</Card.Title>
				<Card.Description>
					{#if status.mode === 'app'}granary acts on GitHub as this app.{:else}Configured from seeds or <code>granary config</code>; meant for tests and older setups.{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-3 text-sm">
				{#if status.app}
					<dl class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
						<dt class="text-muted-foreground">Name</dt><dd class="font-medium break-all">{status.app.name}</dd>
						<dt class="text-muted-foreground">Owner</dt><dd>{status.app.owner}</dd>
						<dt class="text-muted-foreground">App ID</dt><dd class="font-mono">{status.app.appId}</dd>
						<dt class="text-muted-foreground">Created</dt><dd><RelativeTime ms={status.app.createdAt} /></dd>
					</dl>
					<Button variant="outline" size="sm" href={status.app.htmlUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon /> Open on GitHub</Button>
				{/if}
				<div class="flex items-start gap-2" data-testid="github-auth">
					{#if status.auth.ok === true}
						<CheckCircleIcon class="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
						<span>Credentials work{#if status.auth.checkedAt}{' · checked '}<RelativeTime ms={status.auth.checkedAt} />{/if}</span>
					{:else if status.auth.ok === false}
						<CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
						<span>GitHub did not accept the credentials{#if status.auth.error}{': '}<span class="text-muted-foreground">{status.auth.error}</span>{/if}</span>
					{:else}
						<CircleDashedIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
						<span class="text-muted-foreground">Not checked yet</span>
					{/if}
				</div>
				<div class="grid gap-1">
					<span class="text-muted-foreground text-xs">Webhook URL</span>
					<div class="flex flex-wrap items-center gap-2"><code class="bg-muted rounded px-1.5 py-0.5 text-xs break-all">{status.webhookUrl}</code><CopyButton text={status.webhookUrl} /></div>
				</div>
			</Card.Content>
		</Card.Root>

		{#if status.catchup}
			<Card.Root data-testid="github-catchup">
				<Card.Header>
					<Card.Title>Missed webhooks</Card.Title>
					<Card.Description>GitHub does not retry failed webhooks. granary checks the app’s delivery log every few minutes and asks GitHub to send missed ones again.</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-1 text-sm">
					<p>
						Last check: {#if status.catchup.lastPassAt}<RelativeTime ms={status.catchup.lastPassAt} /> ·
							{status.catchup.lastPassRedelivered === 0 ? 'nothing missed' : `${status.catchup.lastPassRedelivered} re-sent`}{:else}not yet{/if}
					</p>
					{#if status.catchup.totalRedelivered > 0}<p class="text-muted-foreground">{status.catchup.totalRedelivered} re-sent in total</p>{/if}
					{#if status.catchup.lastError}<p class="text-amber-700 dark:text-amber-400">Last problem: {status.catchup.lastError}</p>{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		<Card.Root data-testid="github-disconnect">
			<Card.Header>
				<Card.Title>Disconnect</Card.Title>
				<Card.Description>Stop granary acting on GitHub. The stored app credentials are deleted; your per-repository choices are kept for a later reconnect.</Card.Description>
			</Card.Header>
			<Card.Content class="text-muted-foreground grid gap-3 text-sm">
				<p>Afterwards, delete the app on GitHub too{#if status.app}{' '}(<a class="underline-offset-2 hover:underline" href={status.app.htmlUrl} target="_blank" rel="noreferrer">app settings</a>){/if}, or it keeps sending webhooks that granary will refuse.</p>
				<div>
					<AdminOnly>
						{#snippet children({ disabled })}
							<Button variant="outline" class="text-destructive" {disabled} onclick={() => (confirmDisconnect = true)}>Disconnect GitHub…</Button>
						{/snippet}
					</AdminOnly>
				</div>
			</Card.Content>
		</Card.Root>
	</div>
</div>

<AlertDialog.Root open={confirmDisconnect} onOpenChange={(open) => { if (!open && !disconnecting) confirmDisconnect = false; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Disconnect GitHub?</AlertDialog.Title>
			<AlertDialog.Description>
				granary stops closing issues and refuses webhooks until GitHub is connected again. The app's private key, webhook secret and client secret are deleted from granary.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={disconnecting}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action class={buttonVariants({ variant: 'destructive' })} disabled={disconnecting} onclick={disconnect}>Disconnect</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
