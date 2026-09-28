<script lang="ts">
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import DestinationForm from '$lib/components/ops/DestinationForm.svelte';
	import { listOpsSecrets } from '$lib/remote/ops.remote';

	const secrets = listOpsSecrets();
</script>

<PageHeader title="New destination" description="Cloudflare R2 in the EU jurisdiction is the default. Test the connection, save, then enable." />

<svelte:boundary>
	<DestinationForm destination={null} secrets={await secrets} />
	{#snippet failed(error)}<ErrorAlert {error} />{/snippet}
</svelte:boundary>
