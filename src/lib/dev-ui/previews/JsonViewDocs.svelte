<!-- JSON view docs: usage + the keybinding cheat sheet for the selected keymap (ADR 0057). -->
<script lang="ts">
	import { HELP, HELP_COMMON, type Keymap } from '$lib/components/json-view';
	import type { Args } from '../types';

	let { args }: { args: Args } = $props();
	const keymap = $derived((args.keymap as Keymap) ?? 'vim');
	const usage = $derived(
		[
			'<script lang="ts">',
			"  import { JsonView } from '$lib/components/json-view';",
			"  let mode = $state<'structure' | 'source'>('structure');",
			'</' + 'script>',
			'',
			`<JsonView value={payload} bind:mode keymap="${keymap}"`,
			'  rootLabel="payload" height="24rem"',
			'  onselect={(path, value) => console.log(path, value)} />'
		].join('\n')
	);
</script>

<div class="grid gap-6 lg:grid-cols-2">
	<div class="space-y-2 text-sm">
		<p>A standalone JSON renderer: a collapsible <strong>structure</strong> tree and a pretty-printed <strong>source</strong> view, search by path, vim or emacs navigation, clipboard. Depends only on <code class="font-mono">svelte</code>; see its README.</p>
		<pre class="bg-muted overflow-auto rounded-md p-3 font-mono text-xs">{usage}</pre>
		<p class="text-muted-foreground text-xs">Click inside the viewer and use the keyboard; <kbd class="rounded border px-1 font-mono">?</kbd> opens the in-component help.</p>
	</div>
	<div>
		<h3 class="mb-2 text-sm font-medium">Keys — {keymap}</h3>
		<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
			{#each [...HELP[keymap], ...HELP_COMMON] as h (h.keys)}
				<dt><kbd class="rounded border px-1 font-mono whitespace-nowrap">{h.keys}</kbd></dt>
				<dd class="text-muted-foreground">{h.what}</dd>
			{/each}
		</dl>
	</div>
</div>
