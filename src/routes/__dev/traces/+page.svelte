<script lang="ts">
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import DevSpans from '$lib/components/dev/DevSpans.svelte';
</script>

<PageHeader title="Traces" description="The app's trace buffer as span trees (ADR 0054)." />
<DevSpans />
