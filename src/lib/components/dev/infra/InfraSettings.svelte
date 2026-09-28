<!-- R2 fidelity toggles, clock skew and the exe.dev proxy fronts (ADR 0132, 0137, 0139). -->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import type { FakeInfraInfo, FakeInfraStateValue } from '$lib/schemas/dev';
	import { act } from './act';

	let { info }: { info: FakeInfraInfo } = $props();
	const s = $derived(info.state!);

	type FidelityKey = keyof FakeInfraStateValue['fidelity'];
	const FIDELITY: { key: FidelityKey; label: string; hint: string }[] = [
		{ key: 'sigV4', label: 'SigV4 verification', hint: 'Off: any request is accepted as admin.' },
		{ key: 'regionAuto', label: 'Region auto', hint: 'Accept only auto / us-east-1 / empty, like R2.' },
		{ key: 'conditionalWrites', label: 'Conditional writes', hint: 'If-None-Match: * → 412 when the key exists.' },
		{ key: 'conditionalOnPresigned', label: '…on presigned URLs', hint: 'Off simulates R2 ignoring it (tests the fallback).' },
		{ key: 'equalPartSizes', label: 'Equal part sizes', hint: 'R2 rejects multipart uploads with uneven parts.' },
		{ key: 'perKeyWriteRateLimit', label: '1 write/s per key', hint: '429 SlowDown on faster rewrites.' },
		{ key: 'r2NotImplemented', label: 'No versioning / object lock', hint: '501 NotImplemented, like R2.' }
	];

	let skew = $state('0');
	$effect(() => {
		skew = String(s.clockSkewMs);
	});
	const proxy = (tokenMode: boolean, peerMode: boolean) => act({ action: 'set-exe-proxy', proxy: { tokenMode, peerMode } }, 'exe.dev proxy updated');
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Fidelity, clock &amp; proxy</Card.Title>
		<Card.Description>How closely the fake behaves like R2 and exe.dev.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-5">
		<div class="grid gap-3 sm:grid-cols-2">
			{#each FIDELITY as f (f.key)}
				<div class="flex items-start gap-3">
					<Switch id="fid-{f.key}" checked={s.fidelity[f.key]} onCheckedChange={(v) => act({ action: 'set-fidelity', fidelity: { [f.key]: v } }, `${f.label}: ${v ? 'on' : 'off'}`)} />
					<div class="grid gap-0.5"><Label for="fid-{f.key}">{f.label}</Label><span class="text-muted-foreground text-xs">{f.hint}</span></div>
				</div>
			{/each}
		</div>
		<form class="flex flex-wrap items-end gap-2" onsubmit={(e) => { e.preventDefault(); void act({ action: 'set-clock', clock: { skewMs: Number(skew) } }, `Clock skew ${skew} ms`); }}>
			<div class="grid gap-1"><Label for="skew">Clock skew (ms)</Label><Input id="skew" type="number" bind:value={skew} class="w-40" /></div>
			<Button type="submit" size="sm" variant="outline">Set</Button>
			<Button type="button" size="sm" variant="ghost" onclick={() => act({ action: 'set-clock', clock: { skewMs: 20 * 60_000 } }, 'Clock skew +20 min')}>+20 min (skewed)</Button>
			<Button type="button" size="sm" variant="ghost" onclick={() => act({ action: 'set-clock', clock: { skewMs: 0 } }, 'Clock skew cleared')}>0</Button>
		</form>
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="flex items-start gap-3">
				<Switch id="exe-token" checked={s.exeProxy.tokenPort !== null} onCheckedChange={(v) => proxy(v, s.exeProxy.peerPort !== null)} />
				<div class="grid gap-0.5"><Label for="exe-token">Token front {info.exeTokenUrl ? `(${info.exeTokenUrl})` : ''}</Label><span class="text-muted-foreground text-xs">Needs <code>X-Exedev-Authorization: Bearer</code> with an exe.dev VM token.</span></div>
			</div>
			<div class="flex items-start gap-3">
				<Switch id="exe-peer" checked={s.exeProxy.peerPort !== null} onCheckedChange={(v) => proxy(s.exeProxy.tokenPort !== null, v)} />
				<div class="grid gap-0.5"><Label for="exe-peer">Peer front {info.exePeerUrl ? `(${info.exePeerUrl})` : ''}</Label><span class="text-muted-foreground text-xs">VM-to-VM integration: no credential, the edge adds it.</span></div>
			</div>
		</div>
	</Card.Content>
</Card.Root>
