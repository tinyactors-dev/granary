<!--
	"Add the logo" (ADR 0271): GitHub has no manifest field and no API for an
	app's logo, so granary can't set it. This card makes the one manual step
	quick: the PNG to upload (served by granary itself), the badge background
	colour, and a link straight to the app's settings page. Shown until an
	admin dismisses it; a newly created app shows it again.
-->
<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import XIcon from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import CopyButton from '$lib/components/app/CopyButton.svelte';
	import AdminOnly from '$lib/components/app/AdminOnly.svelte';
	import { describeError } from '$lib/components/app/format';
	import { dismissGitHubLogoHint } from '$lib/remote/settings.remote';

	let { settingsUrl, highlight = false }: { settingsUrl: string; highlight?: boolean } = $props();

	/** Also `GITHUB_BG` in tools/brand/render.ts. */
	const BG = '#1d1710';
	const LOGO = '/brand/granary-github-512.png';
	let dismissing = $state(false);

	async function dismiss() {
		dismissing = true;
		try {
			await dismissGitHubLogoHint();
		} catch (e) {
			toast.error('Could not dismiss', { description: describeError(e).message });
		} finally {
			dismissing = false;
		}
	}
</script>

<Card.Root class={highlight ? 'border-primary/40' : ''} data-testid="github-logo-card">
	<Card.Header class="flex flex-row items-start justify-between gap-3">
		<div class="grid gap-1.5">
			<Card.Title>Add the app logo</Card.Title>
			<Card.Description>GitHub doesn't let apps set their own logo, so upload it once on the app's settings page.</Card.Description>
		</div>
		<AdminOnly reason="Only admins can dismiss this">
			{#snippet children({ disabled })}
				<Button variant="ghost" size="icon" class="size-8" aria-label="Dismiss" title="I've added the logo" onclick={dismiss} disabled={disabled || dismissing} data-testid="github-logo-dismiss">
					<XIcon />
				</Button>
			{/snippet}
		</AdminOnly>
	</Card.Header>
	<Card.Content class="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
		<img src={LOGO} alt="granary logo for GitHub" width="96" height="96" class="size-24 rounded-full" />
		<ol class="grid list-decimal gap-2 pl-5 text-sm">
			<li>
				<a class="inline-flex items-center gap-1 underline underline-offset-2" href={LOGO} download="granary-github-512.png" data-testid="github-logo-download">
					<DownloadIcon class="size-3.5" /> Download the logo
				</a>
				<span class="text-muted-foreground">(PNG, 512 × 512; <a class="underline underline-offset-2" href="/brand/granary-github-1024.png" download="granary-github-1024.png">1024 × 1024</a>)</span>
			</li>
			<li>
				Open the <a class="inline-flex items-center gap-1 underline underline-offset-2" href={settingsUrl} target="_blank" rel="noreferrer" data-testid="github-logo-settings">app's settings on GitHub <ExternalLinkIcon class="size-3.5" /></a>
				→ <strong>Display information</strong> → <strong>Upload a logo</strong>.
			</li>
			<li>
				<span class="inline-flex flex-wrap items-center gap-2">
					<span>Set <strong>Badge background color</strong> to</span>
					<span class="inline-flex items-center gap-1.5">
						<span class="size-4 rounded border" style="background-color: {BG}"></span>
						<code class="bg-muted rounded px-1.5 py-0.5 text-xs">{BG}</code>
						<CopyButton text={BG} label="Copy colour" />
					</span>
				</span>
			</li>
		</ol>
	</Card.Content>
</Card.Root>
