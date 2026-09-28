<!-- Create/edit a telemetry sink (OTLP/HTTP; ADR 0085, 0099, 0107). -->
<script lang="ts">
	import type { SecretMeta, SinkAuth, TelemetrySignal, TelemetrySinkConfig, TelemetrySinkDraft, TestConnectionResult } from '$lib/ops/contract';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
	import SaveIcon from '@lucide/svelte/icons/save';
	import { toast } from 'svelte-sonner';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';
	import { saveOpsSink, testOpsSink } from '$lib/remote/ops.remote';
	import NativeSelect from './NativeSelect.svelte';
	import SecretPicker from './SecretPicker.svelte';
	import TestResult from './TestResult.svelte';
	import ExeSetup from './ExeSetup.svelte';
	import { NEW_SECRET_REF } from './secret-ref';
	import { AUTH_LABEL, AUTH_SECRET_KIND, GiB, fieldIssues } from './format';

	let { sink, secrets }: { sink: TelemetrySinkConfig | null; secrets: SecretMeta[] } = $props();
	const admin = $derived(isAdmin());
	const s0 = untrack(() => $state.snapshot(sink));
	const a0 = s0?.auth;

	let name = $state(s0?.name ?? 'Grafana');
	let enabled = $state(s0?.enabled ?? false);
	let endpoint = $state(s0?.endpoint ?? '');
	let mode = $state<SinkAuth['mode']>(a0?.mode ?? 'none');
	let secretRef = $state<string | null>(a0 && 'token' in a0 ? a0.token.secretRef : a0 && 'password' in a0 ? a0.password.secretRef : a0 && 'value' in a0 ? a0.value.secretRef : null);
	let secretValue = $state('');
	let username = $state(a0?.mode === 'basic' ? a0.username : '');
	let header = $state(a0?.mode === 'header' ? a0.header : 'X-Api-Key');
	let signals = $state<TelemetrySignal[]>(s0?.signals ?? ['traces', 'logs', 'metrics']);
	let budgetGiB = $state((s0?.volumeBudgetBytesPerMonth ?? 5 * GiB) / GiB);
	let grafanaUrl = $state(s0?.grafanaUrl ?? '');

	let issues = $state<Record<string, string>>({});
	let testing = $state(false);
	let saving = $state(false);
	let result = $state<TestConnectionResult | null>(null);

	const secretKind = $derived(AUTH_SECRET_KIND[mode]);
	const newSecret = $derived(!!secretKind && secretRef === null);

	function auth(): SinkAuth {
		const ref = { secretRef: secretRef ?? NEW_SECRET_REF };
		switch (mode) {
			case 'exe-peer':
			case 'none':
				return { mode };
			case 'exe-vm-token':
			case 'bearer':
				return { mode, token: ref };
			case 'basic':
				return { mode, username: username.trim(), password: ref };
			case 'header':
				return { mode, header: header.trim(), value: ref };
		}
	}

	function draft(): TelemetrySinkDraft {
		return {
			...(s0 ? { id: s0.id, version: s0.version } : {}),
			name: name.trim(),
			enabled,
			endpoint: endpoint.trim().replace(/\/+$/, ''),
			auth: auth(),
			signals,
			volumeBudgetBytesPerMonth: Math.round(budgetGiB * GiB),
			...(grafanaUrl.trim() ? { grafanaUrl: grafanaUrl.trim() } : {})
		};
	}

	function check(): boolean {
		const i: Record<string, string> = {};
		if (!name.trim()) i.name = 'Required';
		if (!/^https?:\/\/\S+$/.test(endpoint.trim())) i.endpoint = 'A base URL such as https://grafana-otlp.int.exe.xyz (/v1/<signal> is appended)';
		if (!signals.length) i.signals = 'Pick at least one signal';
		if (newSecret && !secretValue.trim()) i.secret = 'Pick a stored secret or paste a new one';
		if (mode === 'basic' && !username.trim()) i.username = 'Required';
		if (mode === 'header' && !/^[A-Za-z0-9-]+$/.test(header.trim())) i.header = 'Letters, digits and dashes';
		if (mode === 'exe-peer' && !endpoint.includes('.int.exe.xyz')) i.endpoint = 'The peer integration endpoint looks like http://<name>.int.exe.xyz';
		issues = i;
		return Object.keys(i).length === 0;
	}

	async function test() {
		if (!check()) return;
		testing = true;
		result = null;
		try {
			result = await testOpsSink({ draft: draft(), ...(newSecret ? { candidateSecrets: { [NEW_SECRET_REF]: secretValue } } : {}) });
		} catch (e) {
			const msg = describeError(e).message;
			issues = { ...issues, ...fieldIssues(msg, 'draft') };
			toast.error('Test failed to run', { description: msg });
		} finally {
			testing = false;
		}
	}

	async function save() {
		if (!check()) return;
		saving = true;
		try {
			const saved = await saveOpsSink({
				draft: draft(),
				...(newSecret && secretKind ? { secret: { name: `${name.trim()} — ${mode}`, kind: secretKind, value: secretValue } } : {})
			});
			secretValue = '';
			toast.success(`Saved "${saved.name}"`);
			await goto(`/ops/telemetry/${saved.id}`);
		} catch (e) {
			const msg = describeError(e).message;
			issues = { ...issues, ...fieldIssues(msg, 'draft') };
			toast.error('Could not save', { description: msg });
		} finally {
			saving = false;
		}
	}
</script>

{#snippet err(key: string)}
	{#if issues[key]}<p class="text-destructive text-sm" data-testid="field-issue">{issues[key]}</p>{/if}
{/snippet}

<div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
	<form class="grid min-w-0 gap-4" onsubmit={(e) => { e.preventDefault(); void save(); }} data-testid="sink-form">
		<Card.Root>
			<Card.Header>
				<Card.Title>OTLP/HTTP sink</Card.Title>
				<Card.Description>Traces, logs and metrics as OTLP protobuf. Batching, a bounded buffer and a circuit breaker keep a slow Grafana from hurting granary.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 sm:grid-cols-2">
				<div class="grid content-start gap-1.5 sm:col-span-2">
					<Label for="s-name">Name</Label>
					<Input id="s-name" bind:value={name} disabled={!admin} />
					{@render err('name')}
				</div>
				<div class="grid content-start gap-1.5 sm:col-span-2">
					<Label for="s-auth">Authentication</Label>
					<NativeSelect id="s-auth" bind:value={mode} disabled={!admin}>
						{#each Object.entries(AUTH_LABEL) as [m, label] (m)}<option value={m}>{label}</option>{/each}
					</NativeSelect>
				</div>
				{#if mode === 'exe-peer' || mode === 'exe-vm-token'}
					<div class="min-w-0 sm:col-span-2"><ExeSetup {mode} /></div>
				{/if}
				<div class="grid content-start gap-1.5 sm:col-span-2">
					<Label for="s-endpoint">Endpoint</Label>
					<Input id="s-endpoint" bind:value={endpoint} placeholder="https://otlp.example.com" spellcheck={false} disabled={!admin} aria-invalid={issues.endpoint ? true : undefined} />
					{@render err('endpoint')}
				</div>
				{#if mode === 'basic'}
					<div class="grid content-start gap-1.5 sm:col-span-2">
						<Label for="s-user">Username</Label>
						<Input id="s-user" bind:value={username} disabled={!admin} />
						{@render err('username')}
					</div>
				{:else if mode === 'header'}
					<div class="grid content-start gap-1.5 sm:col-span-2">
						<Label for="s-header">Header name</Label>
						<Input id="s-header" bind:value={header} disabled={!admin} />
						{@render err('header')}
					</div>
				{/if}
				{#if secretKind}
					<div class="sm:col-span-2">
						<SecretPicker id="s-secret" label={AUTH_LABEL[mode]} kind={secretKind} {secrets} bind:ref={secretRef} bind:value={secretValue} error={issues.secret} disabled={!admin} />
					</div>
				{/if}
				<fieldset class="grid content-start gap-1.5">
					<legend class="mb-1.5 text-sm font-medium">Signals</legend>
					{#each ['traces', 'logs', 'metrics'] as const as sig (sig)}
						<label class="flex items-center gap-2 text-sm">
							<input type="checkbox" checked={signals.includes(sig)} disabled={!admin} onchange={() => (signals = signals.includes(sig) ? signals.filter((x) => x !== sig) : [...signals, sig])} />
							{sig}
						</label>
					{/each}
					{@render err('signals')}
				</fieldset>
				<div class="grid content-start gap-1.5">
					<Label for="s-budget">Monthly volume cap (GiB)</Label>
					<Input id="s-budget" type="number" min="0.0625" max="100" step="any" bind:value={budgetGiB} disabled={!admin} />
					<p class="text-muted-foreground text-xs">Protects the Grafana VM's disk; sampling is lowered automatically to stay under it. VM-to-VM traffic isn't billed.</p>
					{@render err('volumeBudgetBytesPerMonth')}
				</div>
				<div class="grid content-start gap-1.5 sm:col-span-2">
					<Label for="s-grafana">Grafana link (optional)</Label>
					<Input id="s-grafana" bind:value={grafanaUrl} placeholder="https://grafana.example.com/explore" spellcheck={false} disabled={!admin} />
					{@render err('grafanaUrl')}
				</div>
			</Card.Content>
		</Card.Root>
		<div class="flex flex-wrap items-center gap-3">
			<label class="flex items-center gap-2 text-sm"><Switch bind:checked={enabled} disabled={!admin} /> Enabled</label>
			<div class="ml-auto flex gap-2">
				<Button type="button" variant="outline" disabled={!admin || testing} onclick={test} data-testid="test-sink">
					{#if testing}<LoaderCircleIcon class="animate-spin" />{:else}<PlugZapIcon />{/if} Test
				</Button>
				<Button type="submit" disabled={!admin || saving}>{#if saving}<LoaderCircleIcon class="animate-spin" />{:else}<SaveIcon />{/if} Save</Button>
			</div>
		</div>
	</form>
	<Card.Root>
		<Card.Header>
			<Card.Title>Test</Card.Title>
			<Card.Description>Sends an empty OTLP request and expects 200.</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if result}<TestResult {result} />{:else}<p class="text-muted-foreground text-sm">{s0?.lastTest ? `Last test ${s0.lastTest.ok ? 'passed' : 'failed'}.` : 'Not tested yet.'}</p>{/if}
		</Card.Content>
	</Card.Root>
</div>
