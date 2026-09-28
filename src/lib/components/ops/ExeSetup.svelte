<!-- Copy-paste exe.dev setup for the Grafana VM connection (ADR 0099). -->
<script lang="ts">
	import CopyButton from '$lib/components/app/CopyButton.svelte';

	let { mode }: { mode: 'exe-peer' | 'exe-vm-token' } = $props();
	const peer = 'ssh exe.dev integrations add http-proxy --name grafana-otlp --target https://granary-grafana.exe.xyz:4318/ --peer --attach vm:granary';
	const token = 'ssh exe.dev ssh-key generate-api-key --vm=granary-grafana --label=granary-telemetry';
</script>

<div class="grid min-w-0 gap-2 text-sm break-words" data-testid="exe-setup">
	{#if mode === 'exe-peer'}
		<p>Recommended on exe.dev. exe.dev injects the credential at its edge, so granary stores <strong>nothing</strong>. Run once from your laptop:</p>
		<div class="bg-muted flex items-center gap-2 rounded-md px-3 py-2"><code class="min-w-0 flex-1 overflow-x-auto text-xs whitespace-nowrap">{peer}</code><CopyButton text={peer} /></div>
		<p class="text-muted-foreground text-xs">Then use the endpoint <code>http://grafana-otlp.int.exe.xyz</code>. Requests arrive with an unforgeable <code>X-Exedev-Source-Vm</code> header.</p>
	{:else}
		<p>For use from outside exe.dev (your laptop, staging) or as a fallback. Generate a VM token:</p>
		<div class="bg-muted flex items-center gap-2 rounded-md px-3 py-2"><code class="min-w-0 flex-1 overflow-x-auto text-xs whitespace-nowrap">{token}</code><CopyButton text={token} /></div>
		<p class="text-muted-foreground text-xs">Endpoint <code>https://granary-grafana.exe.xyz:4318</code>; the token is sent as <code>X-Exedev-Authorization: Bearer …</code> and stored encrypted.</p>
	{/if}
</div>
