<!-- Generic controls panel: edits `args` according to the entry's control defs (ADR 0077). -->
<script lang="ts">
	import type { Args, ControlDef } from './types';

	let { controls, args = $bindable() }: { controls: ControlDef[]; args: Args } = $props();
	const label = (c: ControlDef) => c.label ?? c.key;
</script>

<div class="space-y-3 text-sm" data-testid="ui-controls">
	{#each controls as c (c.key)}
		<div class="space-y-1">
			{#if c.type === 'boolean'}
				<label class="flex items-center justify-between gap-2">
					<span class="font-mono text-xs">{label(c)}</span>
					<input type="checkbox" checked={Boolean(args[c.key])} onchange={(e) => (args[c.key] = e.currentTarget.checked)} class="accent-primary" />
				</label>
			{:else}
				<label class="block">
					<span class="font-mono text-xs">{label(c)}</span>
					{#if c.type === 'select'}
						<select class="bg-background mt-1 w-full rounded border px-1.5 py-1 text-xs" value={String(args[c.key] ?? '')} onchange={(e) => (args[c.key] = e.currentTarget.value)}>
							{#each c.options as o (o)}<option value={o}>{o}</option>{/each}
						</select>
					{:else if c.type === 'number'}
						<input
							type="number"
							class="bg-background mt-1 w-full rounded border px-1.5 py-1 text-xs"
							min={c.min}
							max={c.max}
							step={c.step}
							value={Number(args[c.key] ?? 0)}
							oninput={(e) => {
								const v = e.currentTarget.valueAsNumber;
								if (!Number.isNaN(v)) args[c.key] = v;
							}}
						/>
					{:else if c.multiline}
						<textarea
							class="bg-background mt-1 h-28 w-full rounded border p-1.5 font-mono text-xs"
							spellcheck="false"
							value={String(args[c.key] ?? '')}
							oninput={(e) => (args[c.key] = e.currentTarget.value)}
						></textarea>
					{:else}
						<input type="text" class="bg-background mt-1 w-full rounded border px-1.5 py-1 text-xs" value={String(args[c.key] ?? '')} oninput={(e) => (args[c.key] = e.currentTarget.value)} />
					{/if}
				</label>
			{/if}
			{#if c.help}<p class="text-muted-foreground text-[11px]">{c.help}</p>{/if}
		</div>
	{/each}
</div>
