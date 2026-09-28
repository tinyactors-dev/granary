<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import BugIcon from '@lucide/svelte/icons/bug';
	import { toast } from 'svelte-sonner';
	import { logout } from '$lib/remote/session.remote';
	import { shellData } from './session';
	import { describeError } from './format';

	const data = $derived(shellData());
	const user = $derived(data.user);
	const loginHref = $derived(
		`/auth/login?redirect=${encodeURIComponent(page.url.pathname + page.url.search)}`
	);

	async function signOut() {
		try {
			await logout();
			await goto('/', { invalidateAll: true });
			toast.success('Signed out');
		} catch (e) {
			toast.error(`Sign-out failed: ${describeError(e).message}`);
		}
	}
</script>

{#if user}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="ghost" class="h-9 gap-2 px-1.5" aria-label="Account menu">
					<Avatar.Root class="size-7">
						{#if user.avatarUrl}<Avatar.Image src={user.avatarUrl} alt={user.login} />{/if}
						<Avatar.Fallback class="text-xs">{user.login.slice(0, 2).toUpperCase()}</Avatar.Fallback>
					</Avatar.Root>
					<span class="hidden max-w-32 truncate text-sm sm:inline" data-testid="current-user">{user.login}</span>
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-56">
			<DropdownMenu.Label class="flex flex-col gap-0.5">
				<span class="truncate">{user.login}</span>
				<span class="text-muted-foreground flex items-center gap-1 text-xs font-normal">
					{#if user.isAdmin}<ShieldIcon class="size-3" /> Admin{:else}Read-only{/if}
				</span>
			</DropdownMenu.Label>
			<DropdownMenu.Separator />
			{#if data.devMode}
				<DropdownMenu.Item onSelect={() => goto('/admin')}><BugIcon /> Switch user (dev)</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Item onSelect={signOut}><LogOutIcon /> Log out</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{:else}
	<Button href={loginHref} size="sm" data-sveltekit-reload><LogInIcon /> Sign in with GitHub</Button>
{/if}
