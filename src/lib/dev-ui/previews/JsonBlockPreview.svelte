<!-- Renders <JsonBlock> from story args (ADR 0058, ADR 0077). -->
<script lang="ts">
	import JsonBlock from '$lib/components/app/JsonBlock.svelte';
	import type { JsonBlockPreset } from '$lib/components/app/json-block';
	import { jsonDataset } from '../fixtures/json';
	import type { Args } from '../types';

	let { args }: { args: Args } = $props();

	const TINY: Record<string, unknown> = {
		'tiny-array': ['closed'],
		'tiny-object': { login: 'alice', allowed: true },
		'tiny-string': 'not-allowed'
	};

	// "live": a snapshot replaced every second, like the inspector's live mode.
	let tick = $state(0);
	$effect(() => {
		if (args.value !== 'live') return;
		const t = setInterval(() => tick++, 1000);
		return () => clearInterval(t);
	});
	const live = $derived({
		issueKey: '1790584826161-2',
		phase: tick % 6 < 3 ? 'checking' : 'closing',
		attempts: tick,
		issue: { owner: 'acme', repo: 'widgets', number: 2, author: 'eve', association: 'NONE', labels: ['bug', 'needs-triage'] },
		history: Array.from({ length: (tick % 5) + 1 }, (_, i) => ({ at: 1790584826161 + i * 1000, event: i % 2 ? 'github.closed' : 'allowlist.verdict' }))
	});

	const shown = $derived.by((): unknown => {
		const v = String(args.value ?? 'small');
		if (v === 'live') return live;
		if (v in TINY) return TINY[v];
		return jsonDataset(v);
	});
	const blockProps = $derived({
		value: shown,
		preset: (args.preset as JsonBlockPreset) ?? 'compact',
		rootLabel: String(args.rootLabel ?? '$'),
		alwaysTree: Boolean(args.alwaysTree),
		fullscreen: args.fullscreen !== false
	});
</script>

{#if args.context === 'table-cell'}
	<table class="w-full border-collapse text-xs">
		<tbody>
			<tr class="align-top">
				<td class="text-muted-foreground w-[1%] py-1 pr-3 font-mono whitespace-nowrap">scxml.event.data</td>
				<td class="py-1 font-mono break-all"><JsonBlock {...blockProps} /></td>
			</tr>
			<tr class="align-top">
				<td class="text-muted-foreground w-[1%] py-1 pr-3 font-mono whitespace-nowrap">scxml.state.entered</td>
				<td class="py-1 font-mono break-all"><JsonBlock value={['closed']} preset="inline" rootLabel="entered" /></td>
			</tr>
		</tbody>
	</table>
{:else}
	<div class="max-w-2xl">
		<JsonBlock {...blockProps} />
	</div>
{/if}
