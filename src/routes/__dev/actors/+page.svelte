<script lang="ts">
	import { getDevInfo } from '$lib/remote/dev.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { shellData } from '$lib/components/app/session';
	import DevDebugger from '$lib/components/dev/DevDebugger.svelte';

	const info = getDevInfo();
	const signedIn = $derived(shellData().user !== null);
</script>

<PageHeader
	title="Actors & debugger"
	description="Resident actors of the app, a VS Code attach configuration per actor, and a send-event form. Click an actor to inspect it."
/>
<svelte:boundary>
	{@const dev = await info}
	<DevDebugger dapHost={dev.dapHost} dapPort={dev.dapPort} {signedIn} />
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void info.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
