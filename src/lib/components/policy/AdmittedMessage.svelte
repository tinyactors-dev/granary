<!--
	The comment granary posts on each item it reopens when an admin lets the
	author in from Activity (ADR 0314). Admins edit it; everyone signed in
	can read it.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { toast } from 'svelte-sonner';
	import { ADMITTED_VARIABLES } from '$lib/schemas/message-template';
	import { getAdmittedTemplate, saveAdmittedTemplate } from '$lib/remote/allowlist.remote';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { describeError } from '$lib/components/app/format';
	import { isAdmin } from '$lib/components/app/session';

	const status = getAdmittedTemplate();
	const admin = $derived(isAdmin());
	let edited = $state<string | null>(null);
	let saving = $state(false);

	async function save(value: string | null) {
		saving = true;
		try {
			await saveAdmittedTemplate({ template: value });
			edited = null;
			toast.success(value === null ? 'Back to the built-in comment' : 'Comment saved');
		} catch (e) {
			toast.error('Could not save the comment', { description: describeError(e).message });
		} finally {
			saving = false;
		}
	}
</script>

<Card.Root data-testid="admitted-message">
	<Card.Header>
		<Card.Title>The comment when you let someone in</Card.Title>
		<Card.Description>
			Posted on each issue or pull request granary reopens when an admin lets its author in from Activity.
			{#each ADMITTED_VARIABLES as v (v.name)}<code class="mr-1" title={v.description}>{`{{${v.name}}}`}</code>{/each}
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-2">
		<svelte:boundary>
			{@const s = await status}
			{@const draft = edited ?? s.template}
			<Textarea rows={3} value={draft} oninput={(e) => (edited = (e.currentTarget as HTMLTextAreaElement).value)} readonly={!admin} data-testid="admitted-template" />
			<div class="flex flex-wrap gap-2">
				<AdminOnly reason="Only admins can change the comment">
					{#snippet children({ disabled })}
						<Button size="sm" onclick={() => save(draft)} disabled={disabled || saving || edited === null}>Save</Button>
					{/snippet}
				</AdminOnly>
				{#if s.custom}
					<AdminOnly reason="Only admins can change the comment">
						{#snippet children({ disabled })}
							<Button size="sm" variant="ghost" onclick={() => save(null)} disabled={disabled || saving}>Use the built-in comment</Button>
						{/snippet}
					</AdminOnly>
				{/if}
			</div>
			{#snippet failed(error, reset)}
				<ErrorAlert {error} retry={() => { void status.refresh(); reset(); }} />
			{/snippet}
		</svelte:boundary>
	</Card.Content>
</Card.Root>
