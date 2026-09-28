<!-- Status, endpoints, counters and how to point ops at the fake (ADR 0139). -->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import type { FakeInfraInfo } from '$lib/schemas/dev';
	import { act, bytes } from './act';

	let { info }: { info: FakeInfraInfo } = $props();
	const s = $derived(info.state!);
	const bucket = $derived(s.buckets.find((b) => b.jurisdiction === 'eu') ?? s.buckets[0] ?? null);
	const s3Endpoint = $derived(`${info.url}/s3${bucket && bucket.jurisdiction !== 'default' ? `/${bucket.jurisdiction}` : ''}`);
	const endpoints = $derived([
		['S3 / R2 (path-style, region auto)', `${info.url}/s3  ·  EU: ${info.url}/s3/eu`],
		['OTLP direct', `${info.url}/otlp/v1/{traces,logs,metrics}`],
		['exe.dev token front', info.exeTokenUrl ? `${info.exeTokenUrl}/v1/… (X-Exedev-Authorization: Bearer …)` : 'off'],
		['exe.dev peer front', info.exePeerUrl ? `${info.exePeerUrl}/v1/… (no auth)` : 'off']
	]);
	const counters = $derived([
		['S3 writes', String(s.counters.s3Puts)],
		['S3 deletes', String(s.counters.s3Deletes)],
		['Bytes uploaded', bytes(s.counters.s3BytesIn)],
		['OTLP batches', String(s.counters.otlpBatches)],
		['Active faults', String(s.faults.filter((f) => f.remaining > 0).length)],
		['Clock skew', `${s.clockSkewMs} ms`]
	]);
	const envSnippet = $derived(
		[
			'# ops seeds pointing at fake-infra (ADR 0102); keys: issue an S3 credential below or use FAKE_INFRA_SEED_* from config/dev.env',
			`GRANARY_SEED_S3_ENDPOINT=${s3Endpoint}`,
			'GRANARY_SEED_S3_REGION=auto',
			`GRANARY_SEED_S3_BUCKET=${bucket?.name ?? 'granary-backups'}`,
			'GRANARY_SEED_S3_ACCESS_KEY_ID=…',
			'GRANARY_SEED_S3_SECRET_ACCESS_KEY=…',
			info.exePeerUrl ? `GRANARY_SEED_OTLP_ENDPOINT=${info.exePeerUrl}` : `GRANARY_SEED_OTLP_ENDPOINT=${info.url}/otlp`,
			`GRANARY_SEED_OTLP_AUTH=${info.exePeerUrl ? 'exe-peer' : 'none'}`
		].join('\n')
	);
	let resetOpen = $state(false);
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="flex flex-wrap items-center justify-between gap-2">
			<span>Endpoints</span>
			<AlertDialog.Root bind:open={resetOpen}>
				<AlertDialog.Trigger class={buttonVariants({ variant: 'outline', size: 'sm' })}><RotateCcwIcon class="size-4" />Reset</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>Reset fake-infra?</AlertDialog.Title>
						<AlertDialog.Description>Deletes every bucket, object, credential, fault and recorded batch. Dev seeds are re-applied.</AlertDialog.Description>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
						<AlertDialog.Action onclick={async () => { await act({ action: 'reset' }, 'fake-infra reset'); resetOpen = false; }}>Reset</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</Card.Title>
		<Card.Description>Stand-ins for Cloudflare R2, the Grafana OTLP intake and exe.dev's proxy at <code>{info.url}</code>.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<dl class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
			{#each endpoints as [label, value] (label)}
				<dt class="text-muted-foreground">{label}</dt>
				<dd class="min-w-0 font-mono text-xs break-all">{value}</dd>
			{/each}
		</dl>
		<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
			{#each counters as [label, value] (label)}
				<div class="rounded-md border p-2">
					<div class="text-muted-foreground text-xs">{label}</div>
					<div class="text-lg font-semibold tabular-nums">{value}</div>
				</div>
			{/each}
		</div>
		<div class="space-y-1">
			<div class="flex items-center justify-between gap-2">
				<span class="text-sm font-medium">Point ops at it</span>
				<CopyButton text={envSnippet} label="Copy env" />
			</div>
			<pre class="bg-muted overflow-x-auto rounded-md p-3 text-xs">{envSnippet}</pre>
		</div>
	</Card.Content>
</Card.Root>
