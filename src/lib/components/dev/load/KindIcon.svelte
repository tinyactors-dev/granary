<script lang="ts">
	import type { PersonaKind } from '$lib/schemas/dev';
	import { KIND_ICON } from './meta';

	let { kind, class: className = 'size-4' }: { kind: PersonaKind; class?: string } = $props();
	const Icon = $derived(KIND_ICON[kind]);
</script>

<Icon class={className} aria-hidden="true" />
