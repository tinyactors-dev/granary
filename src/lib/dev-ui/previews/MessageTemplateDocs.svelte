<!-- Usage notes for the closing-message editor (ADR 0250–0252). -->
<script lang="ts">
	import { TEMPLATE_VARIABLES } from '$lib/schemas/message-template';
	import type { Args } from '../types';
	let { args: _args }: { args: Args } = $props();
</script>

<div class="grid gap-3 text-sm">
	<p>
		<code>&lt;MessageTemplateEditor bind:value inherited kind label readonly bind:sampleId /&gt;</code> —
		<code>value</code> is the template or <code>null</code> for “inherit” (the built-in default, or the global template when used as a
		per-repository override). Used on <code>/settings/closing-message</code>.
	</p>
	<p>
		Syntax: Markdown with <code>{'{{variable}}'}</code> placeholders — no logic. Unknown variables and stray braces are errors at save
		time. Author-controlled values are escaped (Markdown/HTML) and <code>@</code> gets a zero-width joiner so titles can't mention people;
		<code>@{'{{author}}'}</code> still mentions the author. The system appends the hidden marker; a template can't remove it.
	</p>
	<table class="text-xs">
		<tbody>
			{#each TEMPLATE_VARIABLES as v (v.name)}
				<tr><td class="pr-3 font-mono">{`{{${v.name}}}`}</td><td class="text-muted-foreground">{v.description}</td></tr>
			{/each}
		</tbody>
	</table>
</div>
