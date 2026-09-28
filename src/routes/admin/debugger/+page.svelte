<script lang="ts">
	import * as Alert from '$lib/components/ui/alert/index.js';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { getDevInfo } from '$lib/remote/dev.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { shellData } from '$lib/components/app/session';
	import DevDebugger from '$lib/components/dev/DevDebugger.svelte';

	const shell = $derived(shellData());
	const info = $derived(shell.admin.debugger ? getDevInfo() : null);
	const host = $derived(typeof window === 'undefined' ? '<host>' : window.location.hostname);
</script>

<PageHeader title="Debugger" description="Attach a Debug Adapter Protocol client to one actor, and send events to actors." />
{#if !shell.admin.debugger}
	<Alert.Root>
		<InfoIcon />
		<Alert.Title>The debugger is off here</Alert.Title>
		<Alert.Description>
			<p>In production the debugger stays off unless the server runs with <code>GRANARY_DEBUGGER=1</code>. It then listens on <code>127.0.0.1</code> only; reach it through an SSH tunnel:</p>
			<pre class="bg-muted mt-2 overflow-x-auto rounded-md p-3 font-mono text-xs">ssh -L 4711:127.0.0.1:4711 {host}</pre>
			<p class="mt-2">Then attach your DAP client to <code>localhost:4711</code> (the port is <code>GRANARY_DAP_PORT</code>, default 4711).</p>
		</Alert.Description>
	</Alert.Root>
{:else if info}
	<svelte:boundary>
		{@const dev = await info}
		<DevDebugger dapHost={dev.dapHost} dapPort={dev.dapPort} />
		{#snippet failed(error, reset)}
			<ErrorAlert {error} retry={() => { void info.refresh(); reset(); }} />
		{/snippet}
	</svelte:boundary>
{/if}
