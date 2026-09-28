<!-- Renders <MessageTemplateEditor> from story args (ADR 0077, ADR 0252). -->
<script lang="ts">
	import { MessageTemplateEditor } from '$lib/components/message-template';
	import { DEFAULT_TEMPLATES, type ClosingKind } from '$lib/schemas/message-template';
	import type { Args } from '../types';

	let { args, setArgs }: { args: Args; setArgs?: (patch: Args) => void } = $props();

	const kind = $derived((args.kind === 'pull_request' ? 'pull_request' : 'issue') as ClosingKind);
	const inherited = $derived(typeof args.inherited === 'string' && args.inherited !== '' ? args.inherited : DEFAULT_TEMPLATES[kind]);
	const inheritedLabel = $derived(typeof args.inheritedLabel === 'string' && args.inheritedLabel !== '' ? args.inheritedLabel : 'the built-in default');

	// Controls → canvas: a story or control change sets the editor's value/sample.
	let value = $state<string | null>(null);
	let sampleId = $state('');
	$effect(() => {
		value = args.custom ? String(args.template ?? '') : null;
		sampleId = String(args.sample ?? '');
	});
	// Canvas → controls: typing, inserting a variable, resetting or picking a sample is reported back.
	function report(v: string | null, s: string) {
		const patch: Args = {};
		if ((v !== null) !== Boolean(args.custom)) patch.custom = v !== null;
		if (v !== null && v !== String(args.template ?? '')) patch.template = v;
		if (s !== String(args.sample ?? '')) patch.sample = s;
		if (Object.keys(patch).length) setArgs?.(patch);
	}
</script>

<MessageTemplateEditor
	bind:value={() => value, (v) => ((value = v), report(v, sampleId))}
	bind:sampleId={() => sampleId, (s) => ((sampleId = s), report(value, s))}
	{inherited}
	{inheritedLabel}
	{kind}
	label={String(args.label ?? 'Closing message')}
	readonly={Boolean(args.readonly)}
/>
