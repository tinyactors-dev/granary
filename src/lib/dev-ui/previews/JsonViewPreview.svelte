<!-- Renders <JsonView> from story args (ADR 0077). `json` (text) wins over `dataset` when set. -->
<script lang="ts">
	import { JsonView, type JsonPath, type Keymap, type ViewMode } from '$lib/components/json-view';
	import { jsonDataset } from '../fixtures/json';
	import type { Args } from '../types';

	let { args }: { args: Args } = $props();

	const parsed = $derived.by(() => {
		const text = typeof args.json === 'string' ? args.json.trim() : '';
		if (!text) return { value: jsonDataset(String(args.dataset ?? 'small')), error: null };
		try {
			return { value: JSON.parse(text) as unknown, error: null };
		} catch (e) {
			return { value: null, error: (e as Error).message };
		}
	});

	let mode = $state<ViewMode>('structure');
	$effect(() => {
		mode = (args.mode as ViewMode) ?? 'structure';
	});
	let selected = $state<string>('');
	function onselect(path: JsonPath) {
		selected = JSON.stringify(path);
	}
</script>

{#if parsed.error}
	<p class="text-destructive font-mono text-sm">JSON: {parsed.error}</p>
{:else}
	<JsonView
		value={parsed.value}
		bind:mode
		keymap={(args.keymap as Keymap) ?? 'vim'}
		expandDepth={Number(args.expandDepth ?? 2)}
		maxStringLength={Number(args.maxStringLength ?? 200)}
		theme={(args.theme as 'auto' | 'light' | 'dark') ?? 'auto'}
		rootLabel={String(args.rootLabel ?? '$')}
		height={String(args.height ?? '30rem')}
		{onselect}
	/>
	<div class="text-muted-foreground mt-2 min-h-5 font-mono text-xs" data-testid="selection">onselect: {selected}</div>
{/if}
