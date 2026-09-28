<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import SendIcon from '@lucide/svelte/icons/send';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import type { DevInfo } from '$lib/schemas/dev';
	import { devInjectFault, devOpenIssue, devRedeliver, devReopenIssue, devReset } from '$lib/remote/dev.remote';
	import { DEV_ASSOCIATIONS, describeError, issueHref } from '$lib/components/app/format';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import NativeSelect from './NativeSelect.svelte';
	import FieldIssues from './FieldIssues.svelte';

	let { info }: { info: DevInfo } = $props();

	const fake = $derived(info.fakeGithub);
	const fs = $derived(fake.state);
	const recentDeliveries = $derived([...(fs?.deliveries ?? [])].reverse().slice(0, 15));
	const recentIssues = $derived([...(fs?.issues ?? [])].reverse().slice(0, 15));
	const summary = $derived<[string, number][]>(
		fs
			? [
					['Users', fs.users.length],
					['Repos', fs.repos.length],
					['Issues', fs.issues.length],
					['Deliveries', fs.deliveries.length],
					['Active faults', fs.faults.filter((f) => f.remaining > 0).length]
				]
			: []
	);
	const faultMethods = ['*', 'GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

	let redeliverId = $state('');
	let busy = $state<string | null>(null);
	let resetOpen = $state(false);

	async function run<T>(key: string, fn: () => Promise<T>, success: (r: T) => string) {
		busy = key;
		try {
			const r = await fn();
			toast.success(success(r));
			return r;
		} catch (e) {
			toast.error('Action failed', { description: describeError(e).message });
		} finally {
			busy = null;
		}
	}

	const reopen = (owner: string, repo: string, number: number, actor: string) =>
		run(`reopen:${owner}/${repo}#${number}`, () => devReopenIssue({ owner, repo, number, actor }), (r) => `Reopened ${owner}/${repo}#${number} (${r.deliveryId ? `delivery ${r.deliveryId.slice(0, 8)}…` : 'no GitHub App covers it: nothing delivered'})`);

	const redeliver = (deliveryId: string) =>
		run(`redeliver:${deliveryId}`, () => devRedeliver({ deliveryId }), (r) => `Redelivered ${r.deliveryId.slice(0, 8)}… → ${r.responseCode ?? 'unreachable'}`);

	async function reset() {
		await run('reset', () => devReset(), () => 'Fake GitHub reset');
		resetOpen = false;
	}
</script>

<Card.Root id="fake-github">
	<Card.Header>
		<Card.Title>Fake GitHub</Card.Title>
		<Card.Description>
			Trigger actions on the fake GitHub at <code>{info.fakeGithubUrl}</code>. Webhooks it sends go to this app.
		</Card.Description>
		<Card.Action>
			<Button variant="outline" size="sm" class="text-destructive" onclick={() => (resetOpen = true)} disabled={busy === 'reset'}>
				<RotateCcwIcon /> Reset
			</Button>
		</Card.Action>
	</Card.Header>
	<Card.Content class="space-y-6">
		{#if !fake.reachable}
			<Alert.Root variant="destructive">
				<CircleAlertIcon />
				<Alert.Title>Fake GitHub is not reachable</Alert.Title>
				<Alert.Description>{fake.error ?? 'Unknown error'} — start it with <code>mise run fake-github</code>.</Alert.Description>
			</Alert.Root>
		{:else if fs}
			<div class="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="fake-summary">
				{#each summary as [label, n] (label)}
					<div class="bg-muted/50 rounded-lg border px-3 py-2">
						<div class="text-muted-foreground text-xs">{label}</div>
						<div class="text-xl font-semibold tabular-nums">{n}</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="grid gap-6 xl:grid-cols-2">
			<!-- Open issue -->
			<form
				{...devOpenIssue.enhance(async ({ submit }) => {
					try {
						if (await submit()) {
							const r = devOpenIssue.result;
							if (r) toast.success(`Opened issue #${r.number}`, { description: `Key ${r.issueKey}, ${r.deliveryId ? `delivery ${r.deliveryId.slice(0, 8)}…` : 'not delivered (no GitHub App covers the repo)'}`, action: { label: 'View', onClick: () => (location.href = issueHref(r.issueKey)) } });
						}
					} catch (e) {
						toast.error('Could not open the issue', { description: describeError(e).message });
					}
				})}
				class="space-y-3 rounded-lg border p-4"
				data-testid="open-issue-form"
			>
				<h3 class="flex items-center gap-2 text-sm font-semibold"><SendIcon class="size-4" /> Open an issue as…</h3>
				<div class="grid grid-cols-2 gap-3">
					<div class="grid gap-1.5">
						<Label for="oi-owner">Owner</Label>
						<Input id="oi-owner" {...devOpenIssue.fields.owner.as('text', 'acme')} />
						<FieldIssues issues={devOpenIssue.fields.owner.issues()} />
					</div>
					<div class="grid gap-1.5">
						<Label for="oi-repo">Repo</Label>
						<Input id="oi-repo" {...devOpenIssue.fields.repo.as('text', 'widgets')} />
						<FieldIssues issues={devOpenIssue.fields.repo.issues()} />
					</div>
					<div class="grid gap-1.5">
						<Label for="oi-author">Author</Label>
						<Input id="oi-author" list="fake-users" {...devOpenIssue.fields.author.as('text', 'mallory')} />
						<datalist id="fake-users">
							{#each fake.users as u (u)}<option value={u}></option>{/each}
						</datalist>
						<FieldIssues issues={devOpenIssue.fields.author.issues()} />
					</div>
					<div class="grid gap-1.5">
						<Label for="oi-assoc">Association</Label>
						<NativeSelect id="oi-assoc" {...devOpenIssue.fields.association.as('select', 'NONE')}>
							{#each DEV_ASSOCIATIONS as a (a)}<option value={a}>{a}</option>{/each}
						</NativeSelect>
					</div>
				</div>
				<div class="grid gap-1.5">
					<Label for="oi-title">Title</Label>
					<Input id="oi-title" placeholder="Something is broken" {...devOpenIssue.fields.title.as('text')} />
					<FieldIssues issues={devOpenIssue.fields.title.issues()} />
				</div>
				<div class="grid gap-1.5">
					<Label for="oi-body">Body</Label>
					<Textarea id="oi-body" rows={2} {...devOpenIssue.fields.body.as('text')} />
				</div>
				<FieldIssues issues={devOpenIssue.fields.issues()} />
				<Button type="submit" disabled={devOpenIssue.pending > 0}>
					{#if devOpenIssue.pending}<LoaderCircleIcon class="animate-spin" />{:else}<SendIcon />{/if} Open issue
				</Button>
			</form>

			<div class="space-y-6">
				<!-- Inject fault -->
				<form
					{...devInjectFault.enhance(async ({ submit }) => {
						try {
							if (await submit()) toast.success(`Fault ${devInjectFault.result?.id ?? ''} injected`);
						} catch (e) {
							toast.error('Could not inject the fault', { description: describeError(e).message });
						}
					})}
					class="space-y-3 rounded-lg border p-4"
					data-testid="fault-form"
				>
					<h3 class="flex items-center gap-2 text-sm font-semibold"><ZapIcon class="size-4" /> Inject a REST fault</h3>
					<div class="grid grid-cols-[6rem_1fr] gap-3">
						<div class="grid gap-1.5">
							<Label for="f-method">Method</Label>
							<NativeSelect id="f-method" {...devInjectFault.fields.method.as('select', 'PATCH')}>
								{#each faultMethods as m (m)}<option value={m}>{m}</option>{/each}
							</NativeSelect>
						</div>
						<div class="grid gap-1.5">
							<Label for="f-path">Path pattern (RegExp)</Label>
							<Input id="f-path" class="font-mono" {...devInjectFault.fields.pathPattern.as('text', '/issues/\\d+$')} />
							<FieldIssues issues={devInjectFault.fields.pathPattern.issues()} />
						</div>
					</div>
					<div class="grid grid-cols-3 gap-3">
						<div class="grid gap-1.5">
							<Label for="f-status">Status</Label>
							<Input id="f-status" min={400} max={599} {...devInjectFault.fields.status.as('number', 502)} />
							<FieldIssues issues={devInjectFault.fields.status.issues()} />
						</div>
						<div class="grid gap-1.5">
							<Label for="f-count">Count</Label>
							<Input id="f-count" min={1} {...devInjectFault.fields.count.as('number', 1)} />
							<FieldIssues issues={devInjectFault.fields.count.issues()} />
						</div>
						<div class="grid gap-1.5">
							<Label for="f-retry">Retry-After</Label>
							<Input id="f-retry" min={0} placeholder="—" {...devInjectFault.fields.retryAfter.as('number')} />
							<FieldIssues issues={devInjectFault.fields.retryAfter.issues()} />
						</div>
					</div>
					<FieldIssues issues={devInjectFault.fields.issues()} />
					<Button type="submit" variant="secondary" disabled={devInjectFault.pending > 0}><ZapIcon /> Inject</Button>
				</form>

				<!-- Redeliver -->
				<form
					class="space-y-3 rounded-lg border p-4"
					onsubmit={(e) => {
						e.preventDefault();
						if (redeliverId.trim()) void redeliver(redeliverId.trim());
					}}
				>
					<h3 class="flex items-center gap-2 text-sm font-semibold"><RadioTowerIcon class="size-4" /> Redeliver a webhook</h3>
					<div class="flex gap-2">
						<Input placeholder="delivery id (X-GitHub-Delivery)" class="font-mono" bind:value={redeliverId} aria-label="Delivery id" />
						<Button type="submit" variant="secondary" disabled={!redeliverId.trim() || busy?.startsWith('redeliver:')}>Redeliver</Button>
					</div>
					<p class="text-muted-foreground text-xs">Same delivery id, so granary should deduplicate it.</p>
				</form>
			</div>
		</div>

		{#if fs}
			<Tabs.Root value="issues">
				<Tabs.List>
					<Tabs.Trigger value="issues">Issues ({fs.issues.length})</Tabs.Trigger>
					<Tabs.Trigger value="deliveries">Deliveries ({fs.deliveries.length})</Tabs.Trigger>
					<Tabs.Trigger value="faults">Faults ({fs.faults.length})</Tabs.Trigger>
					<Tabs.Trigger value="raw">Raw state</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="issues">
					<div class="overflow-hidden rounded-lg border">
						<Table.Root>
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head>Issue</Table.Head>
									<Table.Head>Author</Table.Head>
									<Table.Head>State</Table.Head>
									<Table.Head class="text-right">Comments</Table.Head>
									<Table.Head class="w-0"></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each recentIssues as i (`${i.repoId}-${i.number}`)}
									<Table.Row>
										<Table.Cell>
											<a href={issueHref(`${i.repoId}-${i.number}`)} class="font-medium underline-offset-4 hover:underline">{i.owner}/{i.repo}#{i.number}</a>
											<span class="text-muted-foreground block max-w-64 truncate text-xs">{i.title}</span>
										</Table.Cell>
										<Table.Cell class="text-sm">{i.user.login}<span class="text-muted-foreground block font-mono text-[11px]">{i.author_association}</span></Table.Cell>
										<Table.Cell><StateBadge state={i.state} tone={i.state === 'open' ? 'success' : 'info'} /></Table.Cell>
										<Table.Cell class="text-right tabular-nums">{i.comments.length}</Table.Cell>
										<Table.Cell>
											<Button
												variant="outline"
												size="xs"
												disabled={i.state === 'open' || busy === `reopen:${i.owner}/${i.repo}#${i.number}`}
												title="Reopen as the repository owner ({i.owner})"
												onclick={() => reopen(i.owner, i.repo, i.number, i.owner)}
											>Reopen</Button>
										</Table.Cell>
									</Table.Row>
								{:else}
									<Table.Row><Table.Cell colspan={5} class="text-muted-foreground py-6 text-center">No issues on the fake.</Table.Cell></Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				</Tabs.Content>
				<Tabs.Content value="deliveries">
					<div class="overflow-hidden rounded-lg border">
						<Table.Root>
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head>Delivery id</Table.Head>
									<Table.Head>Event</Table.Head>
									<Table.Head>Status</Table.Head>
									<Table.Head class="text-right">Attempts</Table.Head>
									<Table.Head class="text-right">Last attempt</Table.Head>
									<Table.Head class="w-0"></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each recentDeliveries as d (d.id)}
									<Table.Row>
										<Table.Cell class="max-w-44 truncate font-mono text-xs" title={d.id}>{d.id}</Table.Cell>
										<Table.Cell class="font-mono text-xs">{d.event}.{d.action}</Table.Cell>
										<Table.Cell><StateBadge state={d.status} /> <span class="text-muted-foreground text-xs">{d.responseCode ?? '—'}</span></Table.Cell>
										<Table.Cell class="text-right tabular-nums">{d.attempts ?? 1}</Table.Cell>
										<Table.Cell class="text-muted-foreground text-right text-xs"><RelativeTime ms={d.lastAttemptAt ?? null} /></Table.Cell>
										<Table.Cell>
											<Button variant="outline" size="xs" disabled={busy === `redeliver:${d.id}`} onclick={() => redeliver(d.id)}>Redeliver</Button>
										</Table.Cell>
									</Table.Row>
								{:else}
									<Table.Row><Table.Cell colspan={6} class="text-muted-foreground py-6 text-center">No deliveries.</Table.Cell></Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				</Tabs.Content>
				<Tabs.Content value="faults">
					<div class="overflow-hidden rounded-lg border">
						<Table.Root>
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head>Id</Table.Head>
									<Table.Head>Method</Table.Head>
									<Table.Head>Path pattern</Table.Head>
									<Table.Head class="text-right">Status</Table.Head>
									<Table.Head class="text-right">Remaining</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each fs.faults as f (f.id)}
									<Table.Row class={f.remaining === 0 ? 'opacity-50' : ''}>
										<Table.Cell class="font-mono text-xs">{f.id}</Table.Cell>
										<Table.Cell class="font-mono text-xs">{f.method}</Table.Cell>
										<Table.Cell class="font-mono text-xs">{f.pathPattern}</Table.Cell>
										<Table.Cell class="text-right tabular-nums">{f.status}{f.retryAfter !== undefined ? ` (Retry-After ${f.retryAfter})` : ''}</Table.Cell>
										<Table.Cell class="text-right tabular-nums">{f.remaining}</Table.Cell>
									</Table.Row>
								{:else}
									<Table.Row><Table.Cell colspan={5} class="text-muted-foreground py-6 text-center">No faults injected.</Table.Cell></Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				</Tabs.Content>
				<Tabs.Content value="raw">
					<JsonBlock value={fs} preset="panel" rootLabel="state" title="fake GitHub state" alwaysTree />
				</Tabs.Content>
			</Tabs.Root>
		{/if}
	</Card.Content>
</Card.Root>

<AlertDialog.Root bind:open={resetOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Reset the fake GitHub?</AlertDialog.Title>
			<AlertDialog.Description>
				Deletes all fake users, repositories, issues, deliveries and faults. granary's own database is not touched.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action class={buttonVariants({ variant: 'destructive' })} disabled={busy === 'reset'} onclick={reset}>Reset</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
