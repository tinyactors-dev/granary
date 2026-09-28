<!-- fake-infra in the dev portal (ADR 0139): fake R2, OTLP receiver, exe.dev proxy. -->
<script lang="ts">
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { getFakeInfraStatus } from '$lib/remote/infra.remote';
	import InfraOverview from '$lib/components/dev/infra/InfraOverview.svelte';
	import InfraBuckets from '$lib/components/dev/infra/InfraBuckets.svelte';
	import InfraCredentials from '$lib/components/dev/infra/InfraCredentials.svelte';
	import InfraFaults from '$lib/components/dev/infra/InfraFaults.svelte';
	import InfraSettings from '$lib/components/dev/infra/InfraSettings.svelte';
	import InfraTraffic from '$lib/components/dev/infra/InfraTraffic.svelte';

	const status = getFakeInfraStatus();
	let live = $state(true);
	$effect(() => {
		if (!live) return;
		const t = setInterval(() => void status.refresh(), 2000);
		return () => clearInterval(t);
	});
</script>

<PageHeader title="Fake infra" description="The stand-ins ops talks to in development: Cloudflare R2 (S3 API), the Grafana OTLP intake, and exe.dev's proxy. Inject faults, rotate keys, skew the clock." />

<div class="mb-4 flex items-center gap-2">
	<Switch id="infra-live" bind:checked={live} />
	<Label for="infra-live">Live (every 2 s)</Label>
</div>

<svelte:boundary>
	{@const info = await status}
	{#if !info.reachable || !info.state}
		<Alert.Root variant="destructive">
			<CircleAlertIcon />
			<Alert.Title>fake-infra is not reachable at {info.url}</Alert.Title>
			<Alert.Description>{info.error ?? 'No response.'} Start it with <code>mise run up</code> (pitchfork daemon <code>fake-infra</code>) or <code>mise run fake-infra</code>.</Alert.Description>
		</Alert.Root>
	{:else}
		<div class="space-y-4">
			<InfraOverview {info} />
			<div class="grid gap-4 xl:grid-cols-2">
				<InfraBuckets infra={info.state} />
				<div class="space-y-4">
					<InfraCredentials infra={info.state} />
					<InfraSettings {info} />
				</div>
			</div>
			<InfraFaults infra={info.state} />
			<InfraTraffic infra={info.state} />
		</div>
	{/if}
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void status.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
