<!-- Issue or pull request, as a small badge (ADR 0291, 0292). -->
<script lang="ts">
	import type { ItemKind } from '$lib/schemas/api';
	import { KIND_LABELS, KIND_SHORT } from './glossary';

	let { kind, long = false }: { kind: ItemKind; long?: boolean } = $props();
</script>

<span
	class="text-muted-foreground bg-muted mt-0.5 inline-flex h-5 shrink-0 items-center rounded px-1.5 text-[11px] font-medium"
	title={KIND_LABELS[kind]}
	data-testid="item-kind">{long ? KIND_LABELS[kind] : KIND_SHORT[kind]}</span
>
