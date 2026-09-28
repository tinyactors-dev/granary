<!--
  JSON anywhere in the app (ADR 0058): picks a size preset, shows tiny values
  as one line of code, and offers a fullscreen dialog. Wraps the standalone
  $lib/components/json-view component; the keymap is an app-wide preference.
-->
<script lang="ts">
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { JsonView, type ViewMode } from '$lib/components/json-view';
	import { cn } from '$lib/utils';
	import { jsonPrefs } from './json-prefs.svelte';
	import { CHROME_PX, PRESETS, blockHeight, isTiny, oneLine, type JsonBlockPreset } from './json-block';

	let {
		value,
		preset = 'compact',
		rootLabel = '$',
		title,
		expandDepth,
		fullscreen = true,
		/** Render even tiny values as a viewer. */
		alwaysTree = false,
		class: className = ''
	}: {
		value: unknown;
		preset?: JsonBlockPreset;
		rootLabel?: string;
		/** Dialog title (defaults to rootLabel). */
		title?: string;
		expandDepth?: number;
		/** Show the "open fullscreen" button (hide it inside dialogs). */
		fullscreen?: boolean;
		alwaysTree?: boolean;
		class?: string;
	} = $props();

	let mode = $state<ViewMode>('structure');
	let open = $state(false);

	const depth = $derived(expandDepth ?? PRESETS[preset].expandDepth);
	const tiny = $derived(!alwaysTree && isTiny(value));
	let host: HTMLDivElement | undefined = $state();
	let chrome = $state(CHROME_PX);
	const height = $derived(blockHeight(value, preset, depth, chrome));

	$effect(() => jsonPrefs.hydrate());

	// Measure the viewer's real toolbar + status height (the toolbar wraps in
	// narrow containers) so auto-sized blocks show exactly their rows.
	$effect(() => {
		const jv = host?.querySelector<HTMLElement>('.jv');
		const vp = host?.querySelector<HTMLElement>('.jv-viewport');
		if (!jv || !vp) return;
		const measure = () => {
			const c = jv.offsetHeight - vp.offsetHeight;
			if (c > 0 && Math.abs(c - chrome) > 1) chrome = c;
		};
		const ro = new ResizeObserver(measure);
		ro.observe(jv);
		measure();
		return () => ro.disconnect();
	});
</script>

{#if tiny}
	<code class={cn('font-mono text-xs break-all', className)} data-testid="json-inline">{oneLine(value)}</code>
{:else}
	<!-- contain:inline-size keeps the viewer from widening table cells / grid tracks -->
	<div bind:this={host} class={cn('w-full min-w-0 [contain:inline-size]', className)} data-testid="json-block" data-preset={preset}>
		<JsonView {value} bind:mode keymap={jsonPrefs.keymap} expandDepth={depth} {rootLabel} {height} />
		<div class="text-muted-foreground mt-1 flex items-center justify-end gap-3 text-[11px]">
			<button
				type="button"
				class="hover:text-foreground inline-flex items-center gap-1"
				title="Keyboard bindings for all JSON views (press ? inside a view for help)"
				onclick={() => jsonPrefs.toggle()}
				data-testid="json-keymap"
			>
				<KeyboardIcon class="size-3" />{jsonPrefs.keymap} keys
			</button>
			{#if fullscreen}
				<button
					type="button"
					class="hover:text-foreground inline-flex items-center gap-1"
					onclick={() => (open = true)}
					data-testid="json-fullscreen"
				>
					<Maximize2Icon class="size-3" />Fullscreen
				</button>
			{/if}
		</div>
	</div>
	{#if fullscreen}
		<Dialog.Root bind:open>
			<Dialog.Content class="flex h-[90vh] flex-col gap-3 sm:max-w-[min(90vw,72rem)]">
				<Dialog.Header>
					<Dialog.Title class="font-mono">{title ?? rootLabel}</Dialog.Title>
					<Dialog.Description>Press <kbd>?</kbd> in the view for key bindings.</Dialog.Description>
				</Dialog.Header>
				{#if open}
					<div class="min-h-0 flex-1">
						<JsonView {value} bind:mode keymap={jsonPrefs.keymap} expandDepth={Math.max(depth, 3)} {rootLabel} height="100%" />
					</div>
				{/if}
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{/if}
