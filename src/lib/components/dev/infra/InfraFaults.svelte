<!-- Inject faults into the S3, OTLP and exe.dev proxy surfaces (ADR 0134, 0139). -->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import NativeSelect from '../NativeSelect.svelte';
	import type { FakeInfraStateValue } from '$lib/schemas/dev';
	import { act } from './act';

	let { infra }: { infra: FakeInfraStateValue } = $props();

	type Target = 's3' | 'otlp' | 'exe-proxy';
	type Method = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD' | '*';
	let target = $state<Target>('s3');
	let method = $state<Method>('PUT');
	let pathPattern = $state('.');
	let status = $state('503');
	let s3Code = $state('SlowDown');
	let count = $state('3');
	let retryAfterSec = $state('');
	let latencyMs = $state('');
	let dropConnection = $state(false);
	let corruptBody = $state(false);

	const presets: { label: string; apply: () => void }[] = [
		{ label: 'R2 5xx on uploads', apply: () => set('s3', 'PUT', '.', '503', 'SlowDown', '3') },
		{ label: 'Auth revoked (403)', apply: () => set('s3', '*', '.', '403', 'AccessDenied', '1000') },
		{ label: 'Manifest write fails', apply: () => set('s3', 'PUT', 'manifest\\.json', '500', 'InternalError', '2') },
		{ label: 'Grafana down', apply: () => set('otlp', 'POST', '.', '503', '', '1000') },
		{ label: 'exe.dev proxy 502', apply: () => set('exe-proxy', '*', '.', '502', '', '5') }
	];
	function set(t: Target, m: Method, p: string, st: string, code: string, c: string) {
		target = t;
		method = m;
		pathPattern = p;
		status = st;
		s3Code = code;
		count = c;
	}

	async function inject(e: SubmitEvent) {
		e.preventDefault();
		const fault = {
			target,
			method,
			pathPattern,
			count: Number(count),
			...(status ? { status: Number(status) } : {}),
			...(s3Code && target === 's3' ? { s3Code } : {}),
			...(retryAfterSec ? { retryAfterSec: Number(retryAfterSec) } : {}),
			...(latencyMs ? { latencyMs: Number(latencyMs) } : {}),
			...(dropConnection ? { dropConnection } : {}),
			...(corruptBody ? { corruptBody } : {})
		};
		await act({ action: 'inject-fault', fault }, `Fault injected on ${target}`);
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="flex items-center justify-between gap-2">
			Faults
			<Button variant="outline" size="sm" onclick={() => act({ action: 'clear-faults' }, 'All faults cleared')}>Clear all</Button>
		</Card.Title>
		<Card.Description>The next <em>count</em> requests whose method and path (incl. query) match fail. Bun's S3 client retries 3×, so a count of 1 is usually healed.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<div class="flex flex-wrap gap-1">
			{#each presets as p (p.label)}<Button variant="secondary" size="sm" onclick={p.apply}>{p.label}</Button>{/each}
		</div>
		<form class="flex flex-wrap items-end gap-2" onsubmit={inject}>
			<div class="grid gap-1"><Label for="f-t">Target</Label><NativeSelect id="f-t" bind:value={target} class="w-28"><option>s3</option><option>otlp</option><option>exe-proxy</option></NativeSelect></div>
			<div class="grid gap-1"><Label for="f-m">Method</Label><NativeSelect id="f-m" bind:value={method} class="w-24"><option>*</option><option>PUT</option><option>GET</option><option>POST</option><option>DELETE</option><option>HEAD</option></NativeSelect></div>
			<div class="grid gap-1"><Label for="f-p">Path regex</Label><Input id="f-p" bind:value={pathPattern} class="w-36 font-mono" required /></div>
			<div class="grid gap-1"><Label for="f-s">Status</Label><Input id="f-s" type="number" min="400" max="599" bind:value={status} class="w-20" /></div>
			{#if target === 's3'}<div class="grid gap-1"><Label for="f-c">S3 code</Label><Input id="f-c" bind:value={s3Code} class="w-32" /></div>{/if}
			<div class="grid gap-1"><Label for="f-n">Count</Label><Input id="f-n" type="number" min="1" bind:value={count} class="w-20" required /></div>
			<div class="grid gap-1"><Label for="f-r">Retry-After s</Label><Input id="f-r" type="number" min="0" bind:value={retryAfterSec} class="w-24" /></div>
			<div class="grid gap-1"><Label for="f-l">Latency ms</Label><Input id="f-l" type="number" min="0" bind:value={latencyMs} class="w-24" /></div>
			<label class="flex items-center gap-1 text-sm"><input type="checkbox" bind:checked={dropConnection} />drop</label>
			<label class="flex items-center gap-1 text-sm"><input type="checkbox" bind:checked={corruptBody} />corrupt</label>
			<Button type="submit" size="sm"><ZapIcon class="size-4" />Inject</Button>
		</form>
		<div class="overflow-x-auto">
			<Table.Root>
				<Table.Header><Table.Row><Table.Head>Target</Table.Head><Table.Head>Match</Table.Head><Table.Head>Effect</Table.Head><Table.Head class="text-right">Left</Table.Head></Table.Row></Table.Header>
				<Table.Body>
					{#each [...infra.faults].reverse() as f (f.id)}
						<Table.Row class={f.remaining === 0 ? 'opacity-50' : ''}>
							<Table.Cell>{f.target}</Table.Cell>
							<Table.Cell class="font-mono text-xs break-all whitespace-normal">{f.method ?? '*'} /{f.pathPattern}/</Table.Cell>
							<Table.Cell class="text-xs whitespace-normal">{[f.status, f.s3Code, f.retryAfterSec !== undefined && `Retry-After ${f.retryAfterSec}s`, f.latencyMs && `+${f.latencyMs} ms`, f.dropConnection && 'drop', f.corruptBody && 'corrupt'].filter(Boolean).join(' · ')}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{f.remaining}/{f.count}</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row><Table.Cell colspan={4} class="text-muted-foreground">No faults.</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	</Card.Content>
</Card.Root>
