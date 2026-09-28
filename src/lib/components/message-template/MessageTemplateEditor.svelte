<!--
	Closing-message template editor (ADR 0250–0252). Standalone: depends on the
	pure template module, the safe Markdown renderer and shadcn primitives.

	`value` is the template, or null for "inherit" (the built-in default, or the
	global template for a per-repository override); `inherited` is the text null
	stands for. Variables are inserted at the cursor; problems show inline; the
	preview renders the template against sample data as GitHub-flavoured
	Markdown, with the system's hidden marker shown (not rendered) below it.
-->
<script lang="ts">
	import {
		TEMPLATE_SAMPLES,
		TEMPLATE_VARIABLES,
		renderTemplate,
		validateTemplate,
		type ClosingKind
	} from '$lib/schemas/message-template';
	import { renderMarkdown } from './markdown';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';

	let {
		value = $bindable(null),
		inherited,
		inheritedLabel = 'the built-in default',
		kind = 'issue',
		label = 'Closing message',
		readonly = false,
		sampleId = $bindable(''),
		id = 'template'
	}: {
		value?: string | null;
		inherited: string;
		inheritedLabel?: string;
		kind?: ClosingKind;
		label?: string;
		readonly?: boolean;
		sampleId?: string;
		id?: string;
	} = $props();

	let textarea: HTMLTextAreaElement | null = $state(null);
	const custom = $derived(value !== null);
	const effective = $derived(value ?? inherited);
	const problems = $derived(validateTemplate(effective));

	const samples = $derived(TEMPLATE_SAMPLES.filter((s) => s.ctx.kind === kind || s.id === 'mention' || s.id === 'unicode' || s.id === 'long'));
	const sample = $derived(
		TEMPLATE_SAMPLES.find((s) => s.id === sampleId) ?? TEMPLATE_SAMPLES.find((s) => s.ctx.kind === kind) ?? TEMPLATE_SAMPLES[0]!
	);
	const rendered = $derived.by(() => {
		if (problems.length) return null;
		try {
			return renderTemplate(effective, { ...sample.ctx, kind });
		} catch {
			return null;
		}
	});
	const html = $derived(rendered === null ? '' : renderMarkdown(rendered));

	function setCustom(on: boolean) {
		if (readonly) return;
		value = on ? inherited : null;
	}

	function insert(name: string) {
		if (readonly || value === null) return;
		const token = `{{${name}}}`;
		const el = textarea;
		const start = el?.selectionStart ?? value.length;
		const end = el?.selectionEnd ?? value.length;
		value = value.slice(0, start) + token + value.slice(end);
		queueMicrotask(() => {
			el?.focus();
			el?.setSelectionRange(start + token.length, start + token.length);
		});
	}
</script>

<div class="grid gap-3" data-testid="message-template-editor">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<label for={id} class="text-sm font-medium">{label}</label>
		<span class="text-muted-foreground flex items-center gap-2 text-xs">
			<Switch checked={custom} disabled={readonly} onCheckedChange={setCustom} aria-label="Customise {label}" />
			{custom ? 'Custom' : `Using ${inheritedLabel}`}
		</span>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<div class="grid min-w-0 content-start gap-2">
			<Textarea
				{id}
				bind:ref={textarea}
				value={effective}
				oninput={(e) => (value = (e.currentTarget as HTMLTextAreaElement).value)}
				readonly={readonly || !custom}
				rows={8}
				class="font-mono text-sm {custom ? '' : 'text-muted-foreground'}"
				aria-invalid={problems.length > 0}
			/>
			<div class="flex flex-wrap gap-1" aria-label="Insert a variable">
				{#each TEMPLATE_VARIABLES as v (v.name)}
					<button
						type="button"
						class="bg-muted hover:bg-accent disabled:hover:bg-muted rounded px-1.5 py-0.5 font-mono text-xs disabled:opacity-50"
						title={v.description}
						disabled={readonly || !custom}
						onclick={() => insert(v.name)}>{`{{${v.name}}}`}</button
					>
				{/each}
			</div>
			{#if problems.length}
				<ul class="text-destructive grid gap-0.5 text-xs" data-testid="template-problems">
					{#each problems as p, i (i)}<li>{p.message}</li>{/each}
				</ul>
			{/if}
			<p class="text-muted-foreground text-xs">
				Markdown, as on GitHub. Titles and other values from the author are escaped and can't @-mention anyone. granary
				appends a hidden marker (<code>&lt;!-- granary:… --&gt;</code>) so it never comments twice.
			</p>
		</div>

		<div class="grid min-w-0 content-start gap-2">
			<div class="flex flex-wrap items-center gap-1">
				<span class="text-muted-foreground mr-1 text-xs">Preview with</span>
				{#each samples as s (s.id)}
					<Button size="sm" variant={s.id === sample.id ? 'secondary' : 'ghost'} class="h-6 px-2 text-xs" onclick={() => (sampleId = s.id)}
						>{s.label}</Button
					>
				{/each}
			</div>
			<div class="bg-card rounded-md border p-3" data-testid="template-preview">
				{#if rendered === null}
					<p class="text-muted-foreground text-sm">Fix the problems to see a preview.</p>
				{:else if rendered.trim() === ''}
					<p class="text-muted-foreground text-sm">Empty: only the hidden marker is posted.</p>
				{:else}
					<div class="markdown-preview text-sm break-words">{@html html}</div>
				{/if}
				<div class="mt-2 flex items-center gap-1 border-t pt-2">
					<Badge variant="outline" class="font-mono text-[10px]">hidden</Badge>
					<code class="text-muted-foreground truncate text-[11px]">&lt;!-- granary:close:…:{sample.ctx.number} --&gt;</code>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.markdown-preview :global(p) {
		margin: 0 0 0.5rem;
	}
	.markdown-preview :global(p:last-child) {
		margin-bottom: 0;
	}
	.markdown-preview :global(a) {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.markdown-preview :global(code) {
		font-size: 0.85em;
		padding: 0 0.25rem;
		border-radius: 0.25rem;
		background: var(--muted);
	}
	.markdown-preview :global(pre) {
		overflow-x: auto;
		padding: 0.5rem;
		border-radius: 0.375rem;
		background: var(--muted);
	}
	.markdown-preview :global(ul) {
		list-style: disc;
		padding-left: 1.25rem;
		margin: 0 0 0.5rem;
	}
	.markdown-preview :global(ol) {
		list-style: decimal;
		padding-left: 1.25rem;
		margin: 0 0 0.5rem;
	}
	.markdown-preview :global(blockquote) {
		border-left: 3px solid var(--border);
		padding-left: 0.75rem;
		color: var(--muted-foreground);
	}
	.markdown-preview :global(h1),
	.markdown-preview :global(h2),
	.markdown-preview :global(h3) {
		font-weight: 600;
		margin: 0.25rem 0 0.5rem;
	}
	.markdown-preview :global(img) {
		max-width: 100%;
	}
</style>
