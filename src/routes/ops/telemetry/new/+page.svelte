<script lang="ts">
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import SinkForm from '$lib/components/ops/SinkForm.svelte';
	import { listOpsSecrets } from '$lib/remote/ops.remote';

	const secrets = listOpsSecrets();
</script>

<PageHeader title="New telemetry sink" description="Send traces, logs and metrics to any OpenTelemetry (OTLP/HTTP) endpoint, such as Grafana. Test the connection, then save." />
<svelte:boundary>
	<SinkForm sink={null} secrets={await secrets} />
	{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
</svelte:boundary>
