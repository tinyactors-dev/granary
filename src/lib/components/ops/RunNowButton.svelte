<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { toast } from 'svelte-sonner';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { listOpsRuns, runOpsBackupNow } from '$lib/remote/ops.remote';

	let { planId, size = 'sm' }: { planId: string; size?: 'sm' | 'default' } = $props();
	let busy = $state(false);

	async function run() {
		busy = true;
		try {
			const runs = await runOpsBackupNow({ id: planId }).updates(listOpsRuns({ limit: 50 }));
			toast.success(`Backup started`, { description: runs.map((r) => `${r.database}: ${r.id}`).join(', ') });
		} catch (e) {
			toast.error('Could not start a backup', { description: describeError(e).message });
		} finally {
			busy = false;
		}
	}
</script>

<AdminOnly reason="Only admins can start backups">
	{#snippet children({ disabled })}
		<Button variant="outline" {size} disabled={disabled || busy} onclick={run} data-testid="run-backup-now">
			{#if busy}<LoaderCircleIcon class="animate-spin" />{:else}<PlayIcon />{/if} Back up now
		</Button>
	{/snippet}
</AdminOnly>
