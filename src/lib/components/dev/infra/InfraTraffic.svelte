<!-- What reached the fake: OTLP batches and the request log (ADR 0136, 0139). -->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import type { FakeInfraStateValue } from '$lib/schemas/dev';
	import { bytes } from './act';

	let { infra }: { infra: FakeInfraStateValue } = $props();
	const batches = $derived([...infra.otlp].reverse().slice(0, 50));
	const requests = $derived([...infra.requests].reverse().slice(0, 100));
	const statusTone = (n: number) => (n >= 500 ? 'danger' : n >= 400 ? 'warning' : 'success');
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Traffic</Card.Title>
		<Card.Description>Newest first. <code>via</code> shows how telemetry arrived: direct, through the exe.dev token front, or the peer front.</Card.Description>
	</Card.Header>
	<Card.Content>
		<Tabs.Root value="requests">
			<Tabs.List>
				<Tabs.Trigger value="requests">Requests ({infra.requests.length})</Tabs.Trigger>
				<Tabs.Trigger value="otlp">OTLP batches ({infra.otlp.length})</Tabs.Trigger>
			</Tabs.List>
			<Tabs.Content value="requests" class="overflow-x-auto">
				<Table.Root>
					<Table.Header><Table.Row><Table.Head>When</Table.Head><Table.Head>Surface</Table.Head><Table.Head>Request</Table.Head><Table.Head>Status</Table.Head><Table.Head class="text-right">In</Table.Head><Table.Head>Credential / fault</Table.Head></Table.Row></Table.Header>
					<Table.Body>
						{#each requests as r, i (`${r.at}-${i}`)}
							<Table.Row>
								<Table.Cell class="whitespace-nowrap"><RelativeTime ms={r.at} /></Table.Cell>
								<Table.Cell>{r.surface}</Table.Cell>
								<Table.Cell class="min-w-[16rem] font-mono text-xs break-all whitespace-normal">{r.method} {r.path}</Table.Cell>
								<Table.Cell><StateBadge state={String(r.status)} tone={statusTone(r.status)} /></Table.Cell>
								<Table.Cell class="text-right tabular-nums">{r.bytesIn ? bytes(r.bytesIn) : ''}</Table.Cell>
								<Table.Cell class="font-mono text-xs whitespace-normal">{[r.credentialId, r.faultId && `⚡ ${r.faultId}`].filter(Boolean).join(' · ')}</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row><Table.Cell colspan={6} class="text-muted-foreground">No requests yet.</Table.Cell></Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Tabs.Content>
			<Tabs.Content value="otlp" class="overflow-x-auto">
				<Table.Root>
					<Table.Header><Table.Row><Table.Head>When</Table.Head><Table.Head>Signal</Table.Head><Table.Head>Via</Table.Head><Table.Head>Service</Table.Head><Table.Head class="text-right">Size</Table.Head><Table.Head>Contents</Table.Head></Table.Row></Table.Header>
					<Table.Body>
						{#each batches as b, i (`${b.at}-${i}`)}
							<Table.Row>
								<Table.Cell class="whitespace-nowrap"><RelativeTime ms={b.at} /></Table.Cell>
								<Table.Cell>{b.signal}</Table.Cell>
								<Table.Cell>{b.via}</Table.Cell>
								<Table.Cell>{b.service ?? '—'}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{bytes(b.bytes)}</Table.Cell>
								<Table.Cell class="min-w-[14rem] text-xs break-words whitespace-normal">{b.summary.slice(0, 4).join(' · ')}{b.summary.length > 4 ? ` … +${b.summary.length - 4}` : ''}</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row><Table.Cell colspan={6} class="text-muted-foreground">No OTLP batches yet.</Table.Cell></Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Tabs.Content>
		</Tabs.Root>
	</Card.Content>
</Card.Root>
