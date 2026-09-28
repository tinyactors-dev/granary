<script lang="ts">
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import DevSpans from '$lib/components/dev/DevSpans.svelte';
</script>

<PageHeader title="Traces" description="The most recent spans granary kept in memory, as Jaeger-style trees: pick a trace, expand the tree, click a span for its attributes, events and links." />
<DevSpans />
