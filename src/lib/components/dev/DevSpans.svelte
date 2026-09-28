<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import TraceExplorer from './trace/TraceExplorer.svelte';
</script>

<Card.Root id="spans">
	<Card.Header>
		<Card.Title>Traces</Card.Title>
		<Card.Description>
			The app's in-memory trace buffer as Jaeger-style span trees: pick a trace, expand the tree, click a span for its
			attributes, events, links and cause.
		</Card.Description>
	</Card.Header>
	<Card.Content class="px-0">
		<TraceExplorer />
	</Card.Content>
</Card.Root>
