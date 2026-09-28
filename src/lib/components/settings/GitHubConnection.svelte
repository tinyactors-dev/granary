<!--
	A connected GitHub (ADR 0160, 0162, 0210): the app, whether its credentials
	work, missed-webhook catch-up, and the installations with a per-repository
	switch. Disabled repositories still send webhooks; granary records them as
	ignored.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
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
	import { refreshGitHubInstallations, setRepoEnabled } from '$lib/remote/settings.remote';
	import type { GitHubStatus, RepoSummary } from '$lib/schemas/github-app';

	let { status }: { status: GitHubStatus } = $props();

	let refreshing = $state(false);
	let toggling = $state<number | null>(null);

	const guarded = $derived(status.installations.reduce((n, i) => n + i.repos.filter((r) => r.enabled).length, 0));

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

	async function toggle(repo: RepoSummary, enabled: boolean) {
		toggling = repo.repoId;
		try {
			await setRepoEnabled({ repoId: repo.repoId, enabled });
			toast.success(enabled ? `Guarding ${repo.fullName}` : `No longer guarding ${repo.fullName}`);
		} catch (e) {
			toast.error(`Could not change ${repo.fullName}`, { description: describeError(e).message });
		} finally {
			toggling = null;
		}
	}
</script>

<div class="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
	<div class="grid gap-4">
		<Card.Root data-testid="github-installations">
			<Card.Header class="flex flex-row items-start justify-between gap-3">
				<div class="grid gap-1.5">
					<Card.Title>Repositories</Card.Title>
					<Card.Description>
						{guarded} guarded. New issues in a guarded repository are checked against the allowlist; the others are left alone.
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
						<Table.Root>
							<Table.Body>
								{#each inst.repos as repo (repo.repoId)}
									<Table.Row data-testid="github-repo">
										<Table.Cell class="font-medium">{repo.fullName}</Table.Cell>
										<Table.Cell class="text-muted-foreground text-sm">{repo.enabled ? 'guarded' : 'not guarded'}</Table.Cell>
										<Table.Cell class="w-0 text-right">
											<AdminOnly reason="Only admins can change which repositories are guarded">
												{#snippet children({ disabled })}
													<Switch
														checked={repo.enabled}
														disabled={disabled || toggling === repo.repoId || inst.suspended}
														aria-label="Guard {repo.fullName}"
														onCheckedChange={(v) => toggle(repo, v)}
													/>
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
					<p>Last check: {#if status.catchup.lastPassAt}<RelativeTime ms={status.catchup.lastPassAt} /> · {status.catchup.lastPassRedelivered} re-sent{:else}not yet{/if}</p>
					<p class="text-muted-foreground">{status.catchup.totalRedelivered} re-sent in total</p>
					{#if status.catchup.lastError}<p class="text-amber-700 dark:text-amber-400">Last problem: {status.catchup.lastError}</p>{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		<Card.Root>
			<Card.Header>
				<Card.Title>Disconnecting</Card.Title>
			</Card.Header>
			<Card.Content class="text-muted-foreground grid gap-2 text-sm">
				<p>To stop granary acting on GitHub, uninstall or delete the app on GitHub{#if status.app}{' '}(<a class="underline-offset-2 hover:underline" href={status.app.htmlUrl} target="_blank" rel="noreferrer">app settings</a>){/if}, then run this on the server:</p>
				<div class="flex flex-wrap items-center gap-2"><code class="bg-muted text-foreground rounded px-1.5 py-0.5">granary config set github.mode none</code><CopyButton text="granary config set github.mode none" /></div>
			</Card.Content>
		</Card.Root>
	</div>
</div>
