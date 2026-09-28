<!--
	Create/edit a backup destination (ADR 0095, 0096, 0106). R2 in the EU
	jurisdiction is the default. Encryption is always on and not a setting
	(ADR 0097); there is no storage-class choice (ADR 0096).
-->
<script lang="ts">
	import type { Destination, DestinationDraft, DestinationSettings, SecretMeta, TestConnectionResult } from '$lib/ops/contract';
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
	import LockIcon from '@lucide/svelte/icons/lock';
	import { toast } from 'svelte-sonner';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';
	import { saveOpsDestination, testOpsDestination } from '$lib/remote/ops.remote';
	import NativeSelect from './NativeSelect.svelte';
	import SecretPicker from './SecretPicker.svelte';
	import TestResult from './TestResult.svelte';
	import { NEW_SECRET_REF } from './secret-ref';
	import { GiB, JURISDICTIONS, KIND_LABEL, fieldIssues, r2Endpoint, settingsIssues } from './format';

	let { destination, secrets }: { destination: Destination | null; secrets: SecretMeta[] } = $props();

	const admin = $derived(isAdmin());
	// Snapshot the initial values; the form owns its state afterwards.
	const d0 = untrack(() => $state.snapshot(destination));
	const s0 = d0?.settings;

	let name = $state(d0?.name ?? 'Cloudflare R2 (EU)');
	let enabled = $state(d0?.enabled ?? false);
	let kind = $state<DestinationSettings['kind']>(s0?.kind ?? 'r2');
	// R2
	let accountId = $state(s0?.kind === 'r2' ? s0.accountId : '');
	let jurisdiction = $state(s0?.kind === 'r2' ? s0.jurisdiction : 'eu');
	// S3
	let endpoint = $state(s0?.kind === 's3' ? s0.endpoint : '');
	let region = $state(s0?.kind === 's3' ? s0.region : '');
	let virtualHostedStyle = $state(s0?.kind === 's3' ? s0.virtualHostedStyle : false);
	// shared object-store fields
	let bucket = $state(s0?.kind === 'r2' || s0?.kind === 's3' ? s0.bucket : 'granary-backups');
	let prefix = $state(s0?.kind === 'r2' || s0?.kind === 's3' ? s0.prefix : 'prod/');
	let accessKeyId = $state(s0?.kind === 'r2' || s0?.kind === 's3' ? s0.accessKeyId : '');
	let secretRef = $state<string | null>(s0?.kind === 'r2' || s0?.kind === 's3' ? s0.secretAccessKey.secretRef : null);
	let secretValue = $state('');
	// local
	let path = $state(s0?.kind === 'local-dir' ? s0.path : 'backups');
	// retention & caps
	let retention = $state(d0?.retention ?? { keepAllHours: 48, dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12, floor: 3 });
	let capGiB = $state((d0?.caps.maxBytes ?? 8 * GiB) / GiB);
	let maxBackupsPerDatabase = $state(d0?.caps.maxBackupsPerDatabase ?? 82);

	let issues = $state<Record<string, string>>({});
	let testing = $state(false);
	let saving = $state(false);
	let result = $state<TestConnectionResult | null>(null);

	const secretKind = $derived(kind === 's3' ? 's3-secret-access-key' : 'r2-secret-access-key');
	const usesSecret = $derived(kind !== 'local-dir');
	const newSecret = $derived(usesSecret && secretRef === null);
	const changed = $derived(JSON.stringify(settings()) !== JSON.stringify(s0 ?? null));
	const testedOk = $derived(!changed && !!d0 && ((!!d0.lastTest?.ok && d0.lastTest.versionTested === d0.version) || !!result?.ok));

	function settings(): DestinationSettings {
		const ref = { secretRef: secretRef ?? NEW_SECRET_REF };
		if (kind === 'r2') return { kind, accountId: accountId.trim(), jurisdiction, bucket: bucket.trim(), prefix: prefix.trim(), accessKeyId: accessKeyId.trim(), secretAccessKey: ref };
		if (kind === 's3') return { kind, endpoint: endpoint.trim(), region: region.trim(), bucket: bucket.trim(), prefix: prefix.trim(), virtualHostedStyle, accessKeyId: accessKeyId.trim(), secretAccessKey: ref };
		return { kind: 'local-dir', path: path.trim(), maxCopies: 1 };
	}

	function draft(): DestinationDraft {
		return {
			...(d0 ? { id: d0.id, version: d0.version } : {}),
			name: name.trim(),
			enabled,
			settings: settings(),
			retention: { ...retention },
			caps: { maxBytes: Math.round(capGiB * GiB), maxBackupsPerDatabase }
		};
	}

	function check(): boolean {
		const i = settingsIssues(settings(), newSecret && !secretValue.trim());
		if (!name.trim()) i.name = 'Required';
		issues = i;
		return Object.keys(i).length === 0;
	}

	async function test() {
		if (!check()) return;
		testing = true;
		result = null;
		try {
			result = await testOpsDestination(
				changed || !d0 || newSecret
					? { draft: draft(), ...(newSecret ? { candidateSecrets: { [NEW_SECRET_REF]: secretValue } } : {}) }
					: { id: d0.id }
			);
		} catch (e) {
			const msg = describeError(e).message;
			issues = { ...issues, ...fieldIssues(msg, 'draft') };
			toast.error('Test connection failed to run', { description: msg });
		} finally {
			testing = false;
		}
	}

	async function save() {
		if (!check()) return;
		saving = true;
		try {
			const saved = await saveOpsDestination({
				draft: draft(),
				...(newSecret ? { secret: { name: `${name.trim()} — secret access key`, kind: secretKind, value: secretValue } } : {})
			});
			secretValue = '';
			toast.success(`Saved "${saved.name}"`, { description: saved.enabled ? 'Enabled.' : 'Saved disabled — run a successful test, then enable it.' });
			await goto(`/ops/destinations/${saved.id}`, { invalidateAll: false });
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
	<form class="grid min-w-0 gap-4" onsubmit={(e) => { e.preventDefault(); void save(); }} data-testid="destination-form">
		<Card.Root>
			<Card.Header>
				<Card.Title>Where backups go</Card.Title>
				<Card.Description class="flex items-center gap-1.5"><LockIcon class="size-3.5" /> Every backup is compressed and encrypted (AES-256-GCM) before upload. This cannot be turned off.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 sm:grid-cols-2">
				<div class="grid content-start gap-1.5 sm:col-span-2">
					<Label for="d-name">Name</Label>
					<Input id="d-name" bind:value={name} disabled={!admin} aria-invalid={issues.name ? true : undefined} />
					{@render err('name')}
				</div>
				<div class="grid content-start gap-1.5">
					<Label for="d-kind">Kind</Label>
					<NativeSelect id="d-kind" bind:value={kind} disabled={!admin || !!d0}>
						{#each Object.entries(KIND_LABEL) as [k, label] (k)}<option value={k}>{label}</option>{/each}
					</NativeSelect>
				</div>
				{#if kind === 'r2'}
					<div class="grid content-start gap-1.5">
						<Label for="d-jur">Jurisdiction</Label>
						<NativeSelect id="d-jur" bind:value={jurisdiction} disabled={!admin}>
							{#each JURISDICTIONS as j (j.value)}<option value={j.value}>{j.label}</option>{/each}
						</NativeSelect>
						<p class="text-muted-foreground text-xs">{JURISDICTIONS.find((j) => j.value === jurisdiction)?.hint}</p>
					</div>
					<div class="grid content-start gap-1.5 sm:col-span-2">
						<Label for="d-account">Account ID</Label>
						<Input id="d-account" bind:value={accountId} placeholder="32 hex characters" spellcheck={false} disabled={!admin} aria-invalid={issues.accountId ? true : undefined} />
						{@render err('accountId')}
						<p class="text-muted-foreground text-xs">Endpoint: <code>{r2Endpoint(accountId.trim(), jurisdiction)}</code> · region <code>auto</code></p>
					</div>
				{:else if kind === 's3'}
					<div class="grid content-start gap-1.5">
						<Label for="d-region">Region</Label>
						<Input id="d-region" bind:value={region} placeholder="eu-central-1" disabled={!admin} />
						{@render err('region')}
					</div>
					<div class="grid content-start gap-1.5 sm:col-span-2">
						<Label for="d-endpoint">Endpoint</Label>
						<Input id="d-endpoint" bind:value={endpoint} placeholder="https://s3.eu-central-1.amazonaws.com" disabled={!admin} />
						{@render err('endpoint')}
						<label class="text-muted-foreground flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={virtualHostedStyle} disabled={!admin} /> Virtual-hosted-style URLs</label>
					</div>
				{/if}
				{#if kind !== 'local-dir'}
					<div class="grid content-start gap-1.5">
						<Label for="d-bucket">Bucket</Label>
						<Input id="d-bucket" bind:value={bucket} spellcheck={false} disabled={!admin} aria-invalid={issues.bucket ? true : undefined} />
						{@render err('bucket')}
						<p class="text-muted-foreground text-xs">Create it yourself (ops never creates buckets){kind === 'r2' ? ', in the jurisdiction above' : ''}.</p>
					</div>
					<div class="grid content-start gap-1.5">
						<Label for="d-prefix">Prefix</Label>
						<Input id="d-prefix" bind:value={prefix} spellcheck={false} placeholder="prod/" disabled={!admin} aria-invalid={issues.prefix ? true : undefined} />
						{@render err('prefix')}
					</div>
					<div class="grid content-start gap-1.5 sm:col-span-2">
						<Label for="d-akid">Access key ID</Label>
						<Input id="d-akid" bind:value={accessKeyId} spellcheck={false} autocomplete="off" disabled={!admin} aria-invalid={issues.accessKeyId ? true : undefined} />
						{@render err('accessKeyId')}
					</div>
					<div class="sm:col-span-2">
						<SecretPicker id="d-secret" label="Secret access key" kind={secretKind} {secrets} bind:ref={secretRef} bind:value={secretValue} error={issues.secret} disabled={!admin} />
					</div>
					{#if kind === 'r2'}
						<p class="text-muted-foreground text-xs sm:col-span-2">
							In the Cloudflare dashboard create an R2 API token with <strong>Object Read &amp; Write</strong>, scoped to <strong>this bucket only</strong>.
							It can't manage buckets — so nothing here can delete one.
						</p>
					{/if}
				{:else}
					<div class="grid content-start gap-1.5 sm:col-span-2">
						<Label for="d-path">Directory</Label>
						<Input id="d-path" bind:value={path} disabled={!admin} />
						{@render err('path')}
						<p class="text-muted-foreground text-xs">Relative to the ops data directory. Keeps one copy on the same disk for fast restores — it does not count as off-site.</p>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Retention</Card.Title>
				<Card.Description>For operational continuity, not an archive: the caps are hard limits and pruning always gets back under them.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 sm:grid-cols-3">
				{#each [['keepAllHours', 'Keep every backup for (hours)'], ['dailyDays', 'Then one per day for (days)'], ['weeklyWeeks', 'Then one per week for (weeks)'], ['monthlyMonths', 'Then one per month for (months)'], ['floor', 'Always keep the newest (verified)']] as [key, label] (key)}
					<div class="grid content-start gap-1.5">
						<Label for="d-r-{key}">{label}</Label>
						<Input id="d-r-{key}" type="number" min="0" bind:value={retention[key as keyof typeof retention]} disabled={!admin} />
						{@render err(`retention.${key}`)}
					</div>
				{/each}
				<div class="grid content-start gap-1.5">
					<Label for="d-cap">Size cap (GiB)</Label>
					<Input id="d-cap" type="number" min="0.0625" max="100" step="any" bind:value={capGiB} disabled={!admin} />
					{@render err('caps.maxBytes')}
				</div>
				<div class="grid content-start gap-1.5">
					<Label for="d-capn">Max backups per database</Label>
					<Input id="d-capn" type="number" min="3" max="200" bind:value={maxBackupsPerDatabase} disabled={!admin} />
					{@render err('caps.maxBackupsPerDatabase')}
				</div>
			</Card.Content>
		</Card.Root>

		<div class="flex flex-wrap items-center gap-3">
			<label class="flex items-center gap-2 text-sm">
				<Switch bind:checked={enabled} disabled={!admin || (!testedOk && !enabled)} />
				Enabled
			</label>
			{#if !testedOk && !enabled}<span class="text-muted-foreground text-xs">Save and pass a test connection before enabling.</span>{/if}
			<div class="ml-auto flex gap-2">
				<Button type="button" variant="outline" disabled={!admin || testing} onclick={test} data-testid="test-connection">
					{#if testing}<LoaderCircleIcon class="animate-spin" />{:else}<PlugZapIcon />{/if} Test connection
				</Button>
				<Button type="submit" disabled={!admin || saving}>
					{#if saving}<LoaderCircleIcon class="animate-spin" />{:else}<SaveIcon />{/if} Save
				</Button>
			</div>
		</div>
		{@render err('')}
	</form>

	<Card.Root>
		<Card.Header>
			<Card.Title>Test connection</Card.Title>
			<Card.Description>Writes, reads, lists and deletes a probe object under <code>.ops-probe/</code>. Unsaved values are used for the test only.</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if result}
				<TestResult {result} />
			{:else if d0?.lastTest}
				<p class="text-muted-foreground text-sm">Last test {d0.lastTest.ok ? 'passed' : 'failed'}{testedOk ? '' : ' (for an earlier version of these settings)'}.</p>
			{:else}
				<p class="text-muted-foreground text-sm">Not tested yet.</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
