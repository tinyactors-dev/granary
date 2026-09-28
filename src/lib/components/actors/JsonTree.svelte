<!-- Collapsible JSON tree for inspector data (ADR 0056). Recognises the
     `$set` / `$map` tags produced by the server's JSON-safe copy. -->
<script lang="ts">
	import Self from './JsonTree.svelte';

	let {
		value,
		name = null,
		depth = 0,
		openDepth = 2
	}: { value: unknown; name?: string | null; depth?: number; openDepth?: number } = $props();

	type Entry = [string, unknown];

	const tagged = $derived.by((): { tag: 'Set' | 'Map'; inner: unknown } | null => {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
		const keys = Object.keys(value);
		if (keys.length !== 1) return null;
		if (keys[0] === '$set') return { tag: 'Set', inner: (value as { $set: unknown }).$set };
		if (keys[0] === '$map') return { tag: 'Map', inner: (value as { $map: unknown }).$map };
		return null;
	});
	const container = $derived(tagged ? tagged.inner : value);
	const isArray = $derived(Array.isArray(container));
	const isContainer = $derived(typeof container === 'object' && container !== null);
	const entries = $derived.by((): Entry[] => {
		if (!isContainer) return [];
		return isArray
			? (container as unknown[]).map((v, i) => [String(i), v] as Entry)
			: Object.entries(container as Record<string, unknown>);
	});
	const label = $derived(
		tagged ? `${tagged.tag}(${entries.length})` : isArray ? `Array(${entries.length})` : `{${entries.length}}`
	);

	function tone(v: unknown): string {
		if (v === null) return 'text-muted-foreground italic';
		switch (typeof v) {
			case 'string':
				return 'text-emerald-700 dark:text-emerald-400';
			case 'number':
				return 'text-sky-700 dark:text-sky-400';
			case 'boolean':
				return 'text-violet-700 dark:text-violet-400';
			default:
				return '';
		}
	}
</script>

{#snippet key()}
	{#if name !== null}<span class="text-foreground/80">{name}</span><span class="text-muted-foreground">: </span>{/if}
{/snippet}

{#if !isContainer}
	<div class="truncate leading-5" style:padding-left="{depth ? 0.9 : 0}rem" title={typeof value === 'string' ? value : undefined}>
		{@render key()}<span class={tone(value)}>{value === null ? 'null' : typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>
	</div>
{:else}
	<details open={depth < openDepth} style:padding-left="{depth ? 0.9 : 0}rem" class="group">
		<summary class="hover:bg-muted/70 cursor-pointer list-none rounded leading-5 select-none">
			<span class="text-muted-foreground inline-block w-3 transition-transform group-open:rotate-90">▸</span>
			{@render key()}<span class="text-muted-foreground">{label}</span>
		</summary>
		{#each entries as [k, v] (k)}
			<Self value={v} name={k} depth={depth + 1} {openDepth} />
		{:else}
			<div class="text-muted-foreground pl-[0.9rem] italic leading-5">empty</div>
		{/each}
	</details>
{/if}
