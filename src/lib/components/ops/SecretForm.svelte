<!--
	Write-only secret form (ADR 0086): the value is posted once and the input
	is cleared; the response is metadata only. With `secret`, replaces its value.
-->
<script lang="ts">
	import type { SecretKind, SecretMeta } from '$lib/ops/contract';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { toast } from 'svelte-sonner';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';
	import { setOpsSecret } from '$lib/remote/ops.remote';
	import NativeSelect from './NativeSelect.svelte';
	import { SECRET_KIND_LABEL, humanize } from './format';

	let { secret = null, ondone }: { secret?: SecretMeta | null; ondone?: () => void } = $props();
	const f = $derived(secret ? setOpsSecret.for(secret.id) : setOpsSecret);
	const admin = $derived(isAdmin());
	const idp = $derived(secret ? `sec-${secret.id}` : 'sec-new');
</script>

<form
	{...f.enhance(async ({ submit, element }) => {
		try {
			if (await submit()) {
				const meta = f.result;
				element.reset();
				toast.success(secret ? `Replaced "${meta?.name}"` : `Stored "${meta?.name}"`, { description: `Fingerprint ${meta?.fingerprint}. The value will not be shown again.` });
				ondone?.();
			}
		} catch (e) {
			toast.error('Could not store the secret', { description: describeError(e).message });
		}
	})}
	class="grid gap-3"
	data-testid="secret-form"
	autocomplete="off"
>
	{#if secret}<input {...f.fields.id.as('hidden', secret.id)} />{/if}
	<div class="grid content-start gap-1.5">
		<Label for="{idp}-name">Name</Label>
		<Input id="{idp}-name" disabled={!admin} {...f.fields.name.as('text', secret?.name ?? '')} />
		{#each f.fields.name.issues() ?? [] as i, n (n)}<p class="text-destructive text-sm" data-testid="field-issue">{humanize(i.message)}</p>{/each}
	</div>
	<div class="grid content-start gap-1.5">
		<Label for="{idp}-kind">Kind</Label>
		<NativeSelect id="{idp}-kind" disabled={!admin || !!secret} {...f.fields.kind.as('select', secret?.kind ?? 'r2-secret-access-key')}>
			{#each Object.entries(SECRET_KIND_LABEL) as [k, label] (k)}<option value={k as SecretKind}>{label}</option>{/each}
		</NativeSelect>
		{#if secret}<input type="hidden" name="kind" value={secret.kind} />{/if}
	</div>
	<div class="grid content-start gap-1.5">
		<Label for="{idp}-value">{secret ? 'New value' : 'Value'}</Label>
		<Input id="{idp}-value" autocomplete="new-password" spellcheck={false} placeholder="Stored encrypted; never shown again" disabled={!admin} {...f.fields.value.as('password')} />
		{#each f.fields.value.issues() ?? [] as i, n (n)}<p class="text-destructive text-sm" data-testid="field-issue">{humanize(i.message)}</p>{/each}
	</div>
	{#each f.fields.issues() ?? [] as i, n (n)}<p class="text-destructive text-sm">{i.message}</p>{/each}
	<Button type="submit" class="w-fit" disabled={!admin || f.pending > 0}>
		{#if f.pending}<LoaderCircleIcon class="animate-spin" />{:else}<KeyRoundIcon />{/if}
		{secret ? 'Replace value' : 'Store secret'}
	</Button>
</form>
