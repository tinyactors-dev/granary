<script lang="ts">
	import { getDevInfo } from '$lib/remote/dev.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import DevLogin from '$lib/components/dev/DevLogin.svelte';

	const info = getDevInfo();
</script>

<PageHeader title="Sessions" description="Create a session for any login, no OAuth round trip." />
<svelte:boundary>
	{@const dev = await info}
	<DevLogin admins={dev.admins} />
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void info.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
