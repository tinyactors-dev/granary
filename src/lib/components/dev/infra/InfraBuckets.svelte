<!-- Buckets and their objects / open multipart uploads (ADR 0139). -->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import RelativeTime from '$lib/components/app/RelativeTime.svelte';
	import NativeSelect from '../NativeSelect.svelte';
	import type { FakeInfraStateValue } from '$lib/schemas/dev';
	import { act, bytes } from './act';

	let { infra }: { infra: FakeInfraStateValue } = $props();

	let name = $state('');
	let jurisdiction = $state<'eu' | 'default' | 'fedramp'>('eu');
	let quota = $state('');
	let showAll = $state<Record<string, boolean>>({});

	async function create(e: SubmitEvent) {
		e.preventDefault();
		const bucket = { name: name.trim(), jurisdiction, ...(quota ? { quotaBytes: Number(quota) } : {}) };
		if (await act({ action: 'create-bucket', bucket }, `Bucket ${bucket.name} created`)) name = '';
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Buckets</Card.Title>
		<Card.Description>Created here only — like R2, a bucket-scoped token cannot create buckets. EU buckets answer only on <code>/s3/eu</code>.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<form class="flex flex-wrap items-end gap-2" onsubmit={create}>
			<div class="grid gap-1"><Label for="b-name">Name</Label><Input id="b-name" bind:value={name} placeholder="granary-backups" required pattern="[a-z0-9][a-z0-9-]{'{'}1,61{'}'}[a-z0-9]" class="w-48" /></div>
			<div class="grid gap-1"><Label for="b-j">Jurisdiction</Label><NativeSelect id="b-j" bind:value={jurisdiction} class="w-28"><option>eu</option><option>default</option><option>fedramp</option></NativeSelect></div>
			<div class="grid gap-1"><Label for="b-q">Quota (bytes)</Label><Input id="b-q" type="number" min="0" bind:value={quota} placeholder="none" class="w-36" /></div>
			<Button type="submit" size="sm">Create bucket</Button>
		</form>
		{#each infra.buckets as b (b.name)}
			<section class="space-y-2 rounded-md border p-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div class="text-sm"><span class="font-mono font-medium">{b.name}</span> <span class="text-muted-foreground">· {b.jurisdiction} · {b.objects.length} objects · {bytes(b.usedBytes)}{b.quotaBytes !== null ? ` of ${bytes(b.quotaBytes)}` : ''}{b.multipartUploads.length ? ` · ${b.multipartUploads.length} open uploads` : ''}</span></div>
					<Button variant="ghost" size="sm" onclick={() => act({ action: 'delete-bucket', name: b.name }, `Bucket ${b.name} deleted`)}><TrashIcon class="size-4" />Delete</Button>
				</div>
				{#if b.quotaBytes}
					<div class="bg-muted h-1.5 overflow-hidden rounded-full"><div class="bg-primary h-full" style="width: {Math.min(100, (b.usedBytes / b.quotaBytes) * 100)}%"></div></div>
				{/if}
				{#if b.objects.length}
					<ul class="divide-y rounded-md border text-xs">
						{#each showAll[b.name] ? b.objects : b.objects.slice(-15).reverse() as o (o.key)}
							<li class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-2 py-1.5">
								<span class="min-w-0 flex-1 font-mono break-all">{o.key}</span>
								<span class="text-muted-foreground shrink-0 tabular-nums">{bytes(o.size)} · <RelativeTime ms={o.lastModified} /></span>
							</li>
						{/each}
					</ul>
				{#if b.objects.length > 15}
						<Button variant="link" size="sm" onclick={() => (showAll[b.name] = !showAll[b.name])}>{showAll[b.name] ? 'Show newest 15' : `Show all ${b.objects.length}`}</Button>
					{/if}
				{/if}
				{#each b.multipartUploads as u (u.uploadId)}
					<p class="text-muted-foreground text-xs">Open upload <code>{u.uploadId.slice(0, 12)}</code> for <code>{u.key}</code>: {u.parts} parts, started <RelativeTime ms={u.initiatedAt} /></p>
				{/each}
			</section>
		{:else}
			<p class="text-muted-foreground text-sm">No buckets yet.</p>
		{/each}
	</Card.Content>
</Card.Root>
