<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import TraceExplorer from './trace/TraceExplorer.svelte';
</script>

<!-- The page header already says "Traces"; the card only frames the explorer. -->
<Card.Root id="spans">
	<Card.Content class="px-0">
		<TraceExplorer />
	</Card.Content>
</Card.Root>
