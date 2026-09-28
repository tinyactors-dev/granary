<script lang="ts">
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';

	let { rows = 5, columns = 5 }: { rows?: number; columns?: number } = $props();
</script>

<div class="space-y-2 p-2" aria-busy="true" aria-label="Loading">
	{#each { length: rows } as _, r (r)}
		<div class="flex gap-3">
			{#each { length: columns } as _, c (c)}
				<Skeleton class="h-6 flex-1" />
			{/each}
		</div>
	{/each}
</div>
