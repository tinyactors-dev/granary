<script lang="ts">
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import GranaryActorsTable from '$lib/components/admin/GranaryActorsTable.svelte';
	import OpsActorsTable from '$lib/components/admin/OpsActorsTable.svelte';
</script>

<PageHeader title="Actors" description="Every resident actor: granary's own, and the ops module's. Open one to see its statechart, data and queues." />
<GranaryActorsTable />
<OpsActorsTable />
