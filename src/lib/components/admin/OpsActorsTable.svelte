<!-- The ops module's own actor system (ADR 0092), listed read-only in /admin/actors (ADR 0290). -->
<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { listOpsActors } from '$lib/remote/ops.remote';

	const actors = listOpsActors();
	const DESCRIBE: Record<string, string> = {
		'ops-config': 'Owns configuration; reloads after UI saves',
		'backup-plan': 'Schedule; collapses missed windows into one catch-up',
		'backup-run': 'One run: snapshot → seal → upload → finalize',
		upload: 'One upload to one destination, with retries',
		retention: 'Prunes back under the caps',
		'restore-drill': 'Download, decrypt and check a backup',
		'telemetry-sink': 'Batches and ships telemetry; circuit breaker',
		watchdog: 'Samples signals every 30 s',
		condition: 'One watched condition',
		remediator: 'Runs self-healing actions in order'
	};
</script>

<section class="space-y-3" aria-labelledby="ops-actors-heading">
	<div class="flex items-end justify-between gap-3">
		<div>
			<h2 id="ops-actors-heading" class="text-lg font-semibold">Ops module</h2>
			<p class="text-muted-foreground text-sm">Backups, telemetry and self-healing run in a separate actor system. Read-only.</p>
		</div>
		<Button variant="outline" size="sm" onclick={() => actors.refresh()}><RefreshCwIcon class={actors.loading ? 'animate-spin' : ''} /> Refresh</Button>
	</div>
	<div class="bg-card overflow-x-auto rounded-xl border">
		<svelte:boundary>
			<Table.Root stack>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Address</Table.Head>
						<Table.Head>Active states</Table.Head>
						<Table.Head>Scheduling</Table.Head>
						<Table.Head>Role</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{@const list = await actors}
					{#each list as a (a.runtimeId)}
						{@const shared = list.filter((b) => b.address.family === a.address.family && b.address.name === a.address.name).length > 1}
						<Table.Row data-testid="ops-actor">
							<Table.Cell class="font-mono text-xs">{a.address.family}/{a.address.name}{#if shared}<span class="text-muted-foreground" title="Another resident actor has the same address (e.g. an on-demand drill next to the scheduled one)"> · #{a.runtimeId}</span>{/if}</Table.Cell>
							<Table.Cell><div class="flex flex-wrap gap-1">{#each a.activeStates as s (s)}<StateBadge state={s} tone={s === 'attention' ? 'warning' : 'info'} />{/each}</div></Table.Cell>
							<Table.Cell><StateBadge state={a.scheduling} /></Table.Cell>
							<Table.Cell class="text-muted-foreground text-sm">{DESCRIBE[a.address.family] ?? ''}</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row class="hover:bg-transparent"><Table.Cell colspan={4} class="text-muted-foreground py-10 text-center">No ops actors are resident.</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#snippet failed(error)}<div class="p-4"><ErrorAlert {error} /></div>{/snippet}
		</svelte:boundary>
	</div>
</section>
