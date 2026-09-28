<script lang="ts">
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { getDevInfo } from '$lib/remote/dev.remote';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import ErrorAlert from '$lib/components/app/ErrorAlert.svelte';
	import { shellData } from '$lib/components/app/session';
	import DevLogin from '$lib/components/dev/DevLogin.svelte';
	import DevFakeGithub from '$lib/components/dev/DevFakeGithub.svelte';
	import DevDebugger from '$lib/components/dev/DevDebugger.svelte';
	import DevSpans from '$lib/components/dev/DevSpans.svelte';

	const info = getDevInfo();
	const signedIn = $derived(shellData().user !== null);
</script>

<PageHeader
	title="Developer console"
	description="Only available in dev mode: log in as anyone, drive the fake GitHub, attach a debugger, watch spans."
/>

<nav class="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Sections">
	<a href="#login" class="hover:text-foreground">Log in as</a>
	<a href="#fake-github" class="hover:text-foreground">Fake GitHub</a>
	<a href="#debugger" class="hover:text-foreground">Debugger</a>
	<a href="#spans" class="hover:text-foreground">Traces</a>
</nav>

<svelte:boundary>
	{@const dev = await info}
	<div class="space-y-6">
		<DevLogin admins={dev.admins} />
		<DevFakeGithub info={dev} />
		<DevDebugger dapHost={dev.dapHost} dapPort={dev.dapPort} {signedIn} />
		<DevSpans />
	</div>
	{#snippet failed(error, reset)}
		<ErrorAlert {error} retry={() => { void info.refresh(); reset(); }} />
	{/snippet}
</svelte:boundary>
