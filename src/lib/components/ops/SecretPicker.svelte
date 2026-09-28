<!--
	Pick a stored secret or paste a new one (write-only, ADR 0086). A new value
	stays in this component until the parent submits it once; nothing ever
	shows a stored value.
-->
<script lang="ts">
	import type { SecretKind, SecretMeta } from '$lib/ops/contract';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import NativeSelect from './NativeSelect.svelte';
	import { SECRET_KIND_LABEL } from './format';

	let {
		id,
		label,
		kind,
		secrets,
		ref = $bindable(null),
		value = $bindable(''),
		error,
		disabled = false
	}: {
		id: string;
		label: string;
		kind: SecretKind;
		secrets: SecretMeta[];
		/** Chosen stored secret id, or null = "enter a new value". */
		ref?: string | null;
		value?: string;
		error?: string;
		disabled?: boolean;
	} = $props();

	const matching = $derived(secrets.filter((s) => s.kind === kind));
	const selectValue = $derived(ref ?? '__new');
</script>

<div class="grid content-start gap-1.5">
	<Label for="{id}-pick">{label}</Label>
	<NativeSelect id="{id}-pick" value={selectValue} {disabled} onchange={(e) => (ref = e.currentTarget.value === '__new' ? null : e.currentTarget.value)}>
		{#each matching as s (s.id)}
			<option value={s.id}>{s.name} ({s.fingerprint})</option>
		{/each}
		<option value="__new">Enter a new {SECRET_KIND_LABEL[kind].toLowerCase()}…</option>
	</NativeSelect>
	{#if ref === null}
		<Input
			id="{id}-value"
			type="password"
			autocomplete="new-password"
			spellcheck={false}
			placeholder="Paste the value — it is stored encrypted and never shown again"
			bind:value
			{disabled}
			aria-invalid={error ? true : undefined}
		/>
	{/if}
	{#if error}<p class="text-destructive text-sm">{error}</p>{/if}
</div>
