<script lang="ts">
	import { getDevInfo } from '$lib/remote/dev.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import DevFakeGithub from '$lib/components/dev/DevFakeGithub.svelte';

	const info = getDevInfo();
</script>

<PageHeader
	title="Fake GitHub"
	description="Open and reopen issues as any user, redeliver webhooks, inject REST faults, inspect the fake's state."
/>
<svelte:boundary>
	{@const dev = await info}
	<DevFakeGithub info={dev} />
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void info.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
