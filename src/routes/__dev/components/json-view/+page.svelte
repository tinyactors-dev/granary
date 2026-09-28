<!--
  Playground for the standalone <JsonView> component (ADR 0057).
  Dev-only: /__dev/** is 404 outside dev mode (hooks.server.ts).
-->
<script lang="ts">
	import { JsonView, HELP, HELP_COMMON, type JsonPath, type Keymap, type ViewMode } from '$lib/components/json-view';

	type Dataset = { id: string; label: string; make: () => unknown };

	function issueEvent() {
		return {
			action: 'opened',
			issue: {
				id: 2847561023,
				number: 42,
				title: 'App crashes when the config file is empty',
				body: 'Steps to reproduce:\n1. Create an empty granary.toml\n2. Run `granary start`\n\nExpected: a helpful error.',
				state: 'open',
				state_reason: null,
				user: { login: 'mallory', id: 90210, type: 'User', site_admin: false },
				author_association: 'NONE',
				labels: [],
				html_url: 'https://github.com/acme/widgets/issues/42',
				reactions: { total_count: 0, '+1': 0, '-1': 0 }
			},
			repository: { id: 1790584260717, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' }, private: false },
			sender: { login: 'mallory', id: 90210, type: 'User' }
		};
	}

	function deep(levels = 14) {
		let v: Record<string, unknown> = { leaf: true, note: 'bottom of the well' };
		for (let i = levels; i > 0; i--) v = { [`level${i}`]: v, siblings: [i, i * 2], name: `node-${i}` };
		return v;
	}

	function large(rows: number) {
		const states = ['pending', 'inflight', 'done', 'dead'];
		return {
			generatedAt: '2026-09-28T09:00:00.000Z',
			effects: Array.from({ length: rows }, (_, i) => ({
				effect_key: `close:1790584260717:${i + 1}`,
				issue_key: `1790584260717-${i + 1}`,
				state: states[i % 4],
				attempts: i % 7,
				comment_id: i % 3 ? 1790584800000 + i : null,
				last_error: i % 4 === 3 ? `HTTP 503 from POST /repos/acme/widgets/issues/${i + 1}/comments` : null,
				payload: { owner: 'acme', repo: 'widgets', number: i + 1, author: `user${i % 50}` },
				updated_at: 1790584800000 + i * 1000
			}))
		};
	}

	function strings() {
		return {
			ascii: 'plain',
			unicode: 'Grüße, 你好, مرحبا, नमस्ते, こんにちは 👋🏽',
			emoji: '🧪🔥🦀🐙',
			rtl: 'שלום עולם',
			escapes: 'tab\there, newline\nthere, quote " and backslash \\',
			long: 'Lorem ipsum dolor sit amet, '.repeat(120),
			'key with spaces': 1,
			'dotted.key': 2,
			'slash/key~tilde': 3,
			'': 'empty key'
		};
	}

	function numbers() {
		return {
			bigintAsString: '18446744073709551615',
			sessionId: '4294967297',
			realBigint: 9007199254740993n,
			float: 3.14159,
			negative: -42,
			exponent: 6.02e23,
			nan: Number.NaN,
			infinity: Number.POSITIVE_INFINITY,
			bools: [true, false],
			nothing: null,
			missing: undefined
		};
	}

	function people() {
		const names = ['alice', 'bob', 'carol', 'dave', 'eve', 'mallory', 'trent'];
		return names.map((login, i) => ({
			login,
			id: 1000 + i,
			association: i < 2 ? 'MEMBER' : 'NONE',
			allowed: i < 3,
			issues: Array.from({ length: i % 3 }, (_, k) => ({ number: i * 10 + k, title: `Issue ${k} by ${login}` }))
		}));
	}

	function inspectorShapes() {
		return {
			logins: { $set: ['alice', 'zoe', 'admin'] },
			byRepo: { $map: { 'acme/widgets': 3, 'acme/gears': 1 } },
			startedAt: '2026-09-28T08:55:11.458Z',
			buffer: '[Uint8Array 12 bytes]',
			fn: '[Function checkAllowed]',
			self: '[Circular]',
			error: { name: 'TypeError', message: 'Cannot read properties of null' },
			big: '…',
			'…': '312 more keys'
		};
	}

	function jsValues() {
		const o: Record<string, unknown> = {
			set: new Set(['a', 'b', 'c']),
			map: new Map<unknown, unknown>([
				['alice', { allowed: true }],
				[42, 'numeric key']
			]),
			date: new Date('2026-09-28T09:00:00Z'),
			bigint: 12345678901234567890n,
			fn: function checkAllowed() {},
			typed: new Uint8Array(12)
		};
		o.self = o; // cycle
		return o;
	}

	const datasets: Dataset[] = [
		{ id: 'small', label: 'Webhook payload (small)', make: issueEvent },
		{ id: 'deep', label: 'Deeply nested (14 levels)', make: () => deep(14) },
		{ id: 'large10k', label: 'Large: 1,100 effects (~12k nodes)', make: () => large(1100) },
		{ id: 'large50k', label: 'Huge: 5,000 effects (~55k nodes)', make: () => large(5000) },
		{ id: 'strings', label: 'Unicode & long strings, odd keys', make: strings },
		{ id: 'numbers', label: 'Numbers, bigint, null/undefined', make: numbers },
		{ id: 'people', label: 'Array of objects', make: people },
		{ id: 'inspector', label: 'Actor-inspector shapes ($set/$map…)', make: inspectorShapes },
		{ id: 'js', label: 'Live JS values (Map, Set, Date, cycle)', make: jsValues }
	];

	let datasetId = $state('small');
	let custom = $state<unknown>(undefined);
	let useCustom = $state(false);
	const value = $derived(useCustom ? custom : datasets.find((d) => d.id === datasetId)!.make());

	let mode = $state<ViewMode>('structure');
	let keymap = $state<Keymap>('vim');
	let expandDepth = $state(2);
	let maxStringLength = $state(120);
	let theme = $state<'auto' | 'light' | 'dark'>('auto');
	let selected = $state<{ path: JsonPath; preview: string } | null>(null);

	let paste = $state('{\n  "paste": ["any", "JSON", {"here": true}]\n}');
	let pasteError = $state<string | null>(null);

	function applyPaste() {
		try {
			custom = JSON.parse(paste);
			useCustom = true;
			pasteError = null;
		} catch (e) {
			pasteError = (e as Error).message;
		}
	}

	function pick(id: string) {
		datasetId = id;
		useCustom = false;
	}

	function onselect(path: JsonPath, v: unknown) {
		let preview: string;
		try {
			preview = typeof v === 'object' && v !== null ? (Array.isArray(v) ? `Array(${v.length})` : 'Object') : String(v);
		} catch {
			preview = '?';
		}
		selected = { path, preview: preview.slice(0, 80) };
	}
</script>

<svelte:head><title>JsonView playground · granary dev</title></svelte:head>

<div class="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
	<header class="flex flex-col gap-1">
		<h1 class="text-xl font-semibold tracking-tight">JsonView playground</h1>
		<p class="text-muted-foreground text-sm">
			Standalone JSON renderer (<code class="font-mono">$lib/components/json-view</code>). Click inside the
			viewer and use the keyboard — press <kbd class="rounded border px-1 font-mono text-xs">?</kbd> for help.
		</p>
	</header>

	<div class="grid gap-4 lg:grid-cols-[1fr_18rem]">
		<div class="flex min-w-0 flex-col gap-3">
			<div class="flex flex-wrap gap-1.5" role="group" aria-label="Datasets">
				{#each datasets as d (d.id)}
					<button
						type="button"
						class="rounded-md border px-2.5 py-1 text-xs transition-colors {!useCustom && datasetId === d.id
							? 'bg-primary text-primary-foreground border-primary'
							: 'hover:bg-accent'}"
						data-dataset={d.id}
						onclick={() => pick(d.id)}>{d.label}</button
					>
				{/each}
				{#if useCustom}
					<span class="bg-primary text-primary-foreground rounded-md border px-2.5 py-1 text-xs">Pasted JSON</span>
				{/if}
			</div>

			<JsonView {value} bind:mode {keymap} {expandDepth} {maxStringLength} {theme} rootLabel="$" height="34rem" {onselect} />

			<div class="text-muted-foreground flex min-h-6 flex-wrap items-center gap-2 font-mono text-xs" data-testid="selection">
				<span>onselect:</span>
				{#if selected}
					<span class="text-foreground">{JSON.stringify(selected.path)}</span>
					<span>→ {selected.preview}</span>
				{/if}
			</div>
		</div>

		<aside class="flex flex-col gap-4 text-sm">
			<section class="flex flex-col gap-2 rounded-lg border p-3">
				<h2 class="font-medium">Props</h2>
				<label class="flex items-center justify-between gap-2">
					<span>keymap</span>
					<select class="bg-background rounded border px-1.5 py-0.5" bind:value={keymap} data-testid="keymap">
						<option value="vim">vim</option>
						<option value="emacs">emacs</option>
					</select>
				</label>
				<label class="flex items-center justify-between gap-2">
					<span>mode (bindable)</span>
					<select class="bg-background rounded border px-1.5 py-0.5" bind:value={mode}>
						<option value="structure">structure</option>
						<option value="source">source</option>
					</select>
				</label>
				<label class="flex items-center justify-between gap-2">
					<span>expandDepth</span>
					<input class="bg-background w-16 rounded border px-1.5 py-0.5" type="number" min="0" max="20" bind:value={expandDepth} />
				</label>
				<label class="flex items-center justify-between gap-2">
					<span>maxStringLength</span>
					<input class="bg-background w-20 rounded border px-1.5 py-0.5" type="number" min="10" step="10" bind:value={maxStringLength} />
				</label>
				<label class="flex items-center justify-between gap-2">
					<span>theme</span>
					<select class="bg-background rounded border px-1.5 py-0.5" bind:value={theme}>
						<option value="auto">auto</option>
						<option value="light">light</option>
						<option value="dark">dark</option>
					</select>
				</label>
			</section>

			<section class="flex flex-col gap-2 rounded-lg border p-3">
				<h2 class="font-medium">Paste JSON</h2>
				<textarea
					class="bg-background h-32 w-full rounded border p-2 font-mono text-xs"
					spellcheck="false"
					bind:value={paste}
					aria-label="JSON to render"
				></textarea>
				{#if pasteError}<p class="text-destructive text-xs">{pasteError}</p>{/if}
				<button type="button" class="bg-primary text-primary-foreground rounded-md px-3 py-1 text-xs" onclick={applyPaste}
					>Render</button
				>
			</section>

			<section class="flex flex-col gap-2 rounded-lg border p-3">
				<h2 class="font-medium">Keys — {keymap}</h2>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					{#each [...HELP[keymap], ...HELP_COMMON] as h (h.keys)}
						<dt><kbd class="rounded border px-1 font-mono whitespace-nowrap">{h.keys}</kbd></dt>
						<dd class="text-muted-foreground">{h.what}</dd>
					{/each}
				</dl>
			</section>
		</aside>
	</div>
</div>
