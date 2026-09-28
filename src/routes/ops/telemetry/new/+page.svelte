<script lang="ts">
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import SinkForm from '$lib/components/ops/SinkForm.svelte';
	import { listOpsSecrets } from '$lib/remote/ops.remote';

	const secrets = listOpsSecrets();
</script>

<PageHeader title="New telemetry sink" description="The exe.dev VM-to-VM integration is recommended: no credential to store or rotate." />
<svelte:boundary>
	<SinkForm sink={null} secrets={await secrets} />
	{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
</svelte:boundary>
