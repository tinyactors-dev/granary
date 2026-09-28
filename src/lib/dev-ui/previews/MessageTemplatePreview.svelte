<!-- Renders <MessageTemplateEditor> from story args (ADR 0077, ADR 0252). -->
<script lang="ts">
	import { MessageTemplateEditor } from '$lib/components/message-template';
	import { DEFAULT_TEMPLATES, type ClosingKind } from '$lib/schemas/message-template';
	import type { Args } from '../types';

	let { args }: { args: Args } = $props();

	const kind = $derived((args.kind === 'pull_request' ? 'pull_request' : 'issue') as ClosingKind);
	const inherited = $derived(typeof args.inherited === 'string' && args.inherited !== '' ? args.inherited : DEFAULT_TEMPLATES[kind]);
	const inheritedLabel = $derived(typeof args.inheritedLabel === 'string' && args.inheritedLabel !== '' ? args.inheritedLabel : 'the built-in default');

	// The editor owns its value while you type; a story/control change resets it.
	let value = $state<string | null>(null);
	let sampleId = $state('');
	$effect(() => {
		value = args.custom ? String(args.template ?? '') : null;
		sampleId = String(args.sample ?? '');
	});
</script>

<MessageTemplateEditor
	bind:value
	bind:sampleId
	{inherited}
	{inheritedLabel}
	{kind}
	label={String(args.label ?? 'Closing message')}
	readonly={Boolean(args.readonly)}
/>
