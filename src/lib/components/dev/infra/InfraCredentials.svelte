<!-- Issue / revoke S3 keys, exe.dev VM tokens and OTLP bearer tokens (ADR 0139). -->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import StateBadge from '$lib/components/app/StateBadge.svelte';
	import NativeSelect from '../NativeSelect.svelte';
	import type { FakeInfraIssued, FakeInfraStateValue } from '$lib/schemas/dev';
	import { act } from './act';

	let { infra }: { infra: FakeInfraStateValue } = $props();

	let kind = $state<'s3' | 'exe-vm-token' | 'otlp-bearer'>('s3');
	let scope = $state<'object-rw' | 'object-ro' | 'admin'>('object-rw');
	let buckets = $state('');
	let label = $state('');
	let issued = $state<FakeInfraIssued | null>(null);

	async function issue(e: SubmitEvent) {
		e.preventDefault();
		const credential =
			kind === 's3'
				? { kind, scope, buckets: buckets.split(',').map((b: string) => b.trim()).filter(Boolean) }
				: { kind, label: label.trim() || kind };
		const r = await act({ action: 'issue-credential', credential }, 'Credential issued');
		if (r?.issued) issued = r.issued;
	}
	const secretText = $derived(
		issued ? (issued.kind === 's3' ? `accessKeyId=${issued.accessKeyId}\nsecretAccessKey=${issued.secretAccessKey}` : `token=${issued.token}`) : ''
	);
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Credentials</Card.Title>
		<Card.Description>S3 keys are scoped to buckets (R2's Object Read &amp; Write token). Secrets are shown once, right after issuing.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<form class="flex flex-wrap items-end gap-2" onsubmit={issue}>
			<div class="grid gap-1"><Label for="c-kind">Kind</Label><NativeSelect id="c-kind" bind:value={kind} class="w-40"><option value="s3">S3 access key</option><option value="exe-vm-token">exe.dev VM token</option><option value="otlp-bearer">OTLP bearer</option></NativeSelect></div>
			{#if kind === 's3'}
				<div class="grid gap-1"><Label for="c-scope">Scope</Label><NativeSelect id="c-scope" bind:value={scope} class="w-32"><option>object-rw</option><option>object-ro</option><option>admin</option></NativeSelect></div>
				<div class="grid gap-1"><Label for="c-b">Buckets</Label><Input id="c-b" bind:value={buckets} placeholder="granary-backups" required class="w-52" /></div>
			{:else}
				<div class="grid gap-1"><Label for="c-l">Label</Label><Input id="c-l" bind:value={label} placeholder="granary-vm" class="w-52" /></div>
			{/if}
			<Button type="submit" size="sm"><KeyRoundIcon class="size-4" />Issue</Button>
		</form>
		{#if issued}
			<Alert.Root>
				<Alert.Title class="flex items-center justify-between gap-2">New {issued.kind} credential <code class="text-xs">{issued.id}</code> <CopyButton text={secretText} /></Alert.Title>
				<Alert.Description><pre class="text-xs break-all whitespace-pre-wrap">{secretText}</pre></Alert.Description>
			</Alert.Root>
		{/if}
		<div class="overflow-x-auto">
			<Table.Root>
				<Table.Header><Table.Row><Table.Head>Credential</Table.Head><Table.Head>State</Table.Head><Table.Head></Table.Head></Table.Row></Table.Header>
				<Table.Body>
					{#each infra.credentials as c (c.id)}
						<Table.Row>
							<Table.Cell class="text-xs whitespace-normal">
								<div><span class="font-mono">{c.id}</span> · {c.kind}{c.scope ? ` · ${c.scope}` : ''}</div>
								{#if c.label}<div class="text-muted-foreground font-mono break-all">{c.label}</div>{/if}
							</Table.Cell>
							<Table.Cell><StateBadge state={c.revoked ? 'revoked' : 'active'} tone={c.revoked ? 'muted' : 'success'} /></Table.Cell>
							<Table.Cell class="text-right">{#if !c.revoked}<Button variant="ghost" size="sm" onclick={() => act({ action: 'revoke-credential', id: c.id }, `Revoked ${c.id}`)}>Revoke</Button>{/if}</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row><Table.Cell colspan={3} class="text-muted-foreground">No credentials.</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	</Card.Content>
</Card.Root>
