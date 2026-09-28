<script lang="ts">
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import { toast } from 'svelte-sonner';
	import { devLoginAs } from '$lib/remote/dev.remote';
	import { shellData } from '$lib/components/app/session';
	import { describeError } from '$lib/components/app/format';
	import FieldIssues from './FieldIssues.svelte';

	let { admins }: { admins: string[] } = $props();

	const user = $derived(shellData().user);
	const redirectTo = $derived.by(() => {
		const r = page.url.searchParams.get('redirect');
		return r && /^\/(?!\/)/.test(r) ? r : '/';
	});
	const quick = $derived([...new Set([...admins, 'admin', 'alice', 'mallory'])]);

	let formEl = $state<HTMLFormElement | null>(null);

	/** Quick buttons fill the one `login` field and submit (one remote form = one <form>). */
	async function quickLogin(login: string) {
		devLoginAs.fields.login.set(login);
		await tick();
		formEl?.requestSubmit();
	}

	const enhanced = devLoginAs.enhance(async ({ submit }) => {
		try {
			await submit();
		} catch (e) {
			toast.error('Login failed', { description: describeError(e).message });
		}
	});
</script>

<Card.Root id="login">
	<Card.Header>
		<Card.Title>1 · Log in as</Card.Title>
		<Card.Description>
			Creates a session directly, without OAuth. Currently
			{#if user}signed in as <strong>{user.login}</strong>{user.isAdmin ? ' (admin)' : ' (read-only)'}.{:else}anonymous.{/if}
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		<form {...enhanced} bind:this={formEl} class="space-y-4">
			<input {...devLoginAs.fields.redirectTo.as('hidden', redirectTo)} />
			<div class="flex flex-wrap gap-2" data-testid="quick-login">
				{#each quick as login (login)}
					<Button
						variant={admins.includes(login) ? 'default' : 'outline'}
						size="sm"
						disabled={devLoginAs.pending > 0}
						onclick={() => quickLogin(login)}
					>
						{#if admins.includes(login)}<ShieldIcon />{/if}{login}
					</Button>
				{/each}
			</div>
			<div class="flex items-end gap-2">
				<div class="grid flex-1 gap-1.5">
					<Label for="dev-login">Any login</Label>
					<Input id="dev-login" placeholder="octocat" autocomplete="off" {...devLoginAs.fields.login.as('text')} />
				</div>
				<Button type="submit" variant="secondary" disabled={devLoginAs.pending > 0}><LogInIcon /> Log in</Button>
			</div>
		</form>
		<FieldIssues issues={devLoginAs.fields.allIssues()} />
		<p class="text-muted-foreground text-xs">
			Admins (from <code>ADMINS</code>): {admins.join(', ') || 'none'}. After logging in you go to
			<code>{redirectTo}</code>.
		</p>
	</Card.Content>
</Card.Root>
