<!--
  @component
  JsonView — standalone JSON renderer with a structure (tree) and a source
  (pretty-printed) view, key/path search, vim/emacs keyboard navigation and
  clipboard integration. Rows are virtualized. See ./README.md.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		buildTree,
		computeRows,
		copyableValue,
		displayValue,
		formatPath,
		hasChildren,
		highlight,
		isContainer,
		parseQuery,
		pathOf,
		reveal,
		safeStringify,
		search,
		setAll,
		toPointer,
		type JsonPath,
		type JsonTree,
		type ViewMode
	} from './tree';
	import { HELP, HELP_COMMON, resolveKey, type Action, type Keymap } from './keymap';
	import { copyText } from './clipboard';

	interface Props {
		/** Any value: JSON, or JS values (bigint, Map, Set, Date, cycles are handled). */
		value: unknown;
		/** 'structure' (tree) or 'source' (pretty JSON). Bindable. */
		mode?: ViewMode;
		keymap?: Keymap;
		/** Containers shallower than this start expanded (default 2). */
		expandDepth?: number;
		/** Label shown for the root node and used when copying the root path. */
		rootLabel?: string;
		/** Strings longer than this are truncated (click / Enter to show all). */
		maxStringLength?: number;
		/** Row height in px (rows are virtualized with a fixed height). */
		rowHeight?: number;
		/** CSS height of the whole component (default 28rem). */
		height?: string;
		/** 'auto' follows the inherited color-scheme; force with 'light' / 'dark'. */
		theme?: 'auto' | 'light' | 'dark';
		/** Called when the cursor moves to a node. */
		onselect?: (path: JsonPath, value: unknown) => void;
		/**
		 * When `value` is replaced (e.g. a polled snapshot), keep expanded
		 * nodes and the cursor on the same paths (default true). With false,
		 * a new value starts fresh from `expandDepth`.
		 */
		preserveState?: boolean;
		/**
		 * Optional muted hint after a primitive value in the structure view
		 * (e.g. an epoch-ms number shown as a date). Return null for none.
		 */
		describeValue?: (key: string | number | null, value: unknown) => string | null;
		class?: string;
	}

	let {
		value,
		mode = $bindable('structure'),
		keymap = 'vim',
		expandDepth = 2,
		rootLabel = 'root',
		maxStringLength = 200,
		rowHeight = 22,
		height = '28rem',
		theme = 'auto',
		onselect,
		describeValue,
		preserveState = true,
		class: className = ''
	}: Props = $props();

	// Unique per instance and identical on server and client (hydration-safe).
	const instanceId = $props.id();
	const uid = `jv-${instanceId}`;
	const OVERSCAN = 10;
	const INDENT = 16;

	// --- data -----------------------------------------------------------------
	// A replaced value keeps expansion and cursor by path (preserveState).
	let prevTree: JsonTree | null = null;
	let prevDepth = -1;
	let carriedCursor = 0;
	const tree = $derived.by(() => {
		const t = buildTree(value, expandDepth);
		const old = prevTree;
		carriedCursor = 0;
		if (old && untrack(() => preserveState) && prevDepth === expandDepth) {
			const open = new Set<string>();
			for (let n = 0; n < old.size; n++) if (old.expanded[n] === 1) open.add(old.paths[n]!);
			const cursorPath = old.paths[untrack(() => cursor)] ?? '';
			for (let n = 0; n < t.size; n++) {
				const p = t.paths[n]!;
				if (isContainer(t.kinds[n]!)) t.expanded[n] = n === 0 || open.has(p) ? 1 : 0;
				if (p === cursorPath) carriedCursor = n;
			}
		}
		prevTree = t;
		prevDepth = expandDepth;
		return t;
	});
	let rev = $state(0);
	const bump = () => rev++;
	const rows = $derived.by(() => {
		rev;
		return computeRows(tree, mode);
	});
	const fullStrings = new SvelteSet<number>();

	let cursor = $state(0);

	// --- search -----------------------------------------------------------------
	let query = $state('');
	let valueSearch = $state(false);
	const parsed = $derived(parseQuery(query));
	const matches = $derived(search(tree, query, valueSearch));
	const matchFlags = $derived.by(() => {
		const f = new Uint8Array(tree.size);
		for (const m of matches) f[m] = 1;
		return f;
	});
	let matchPos = $state(-1);
	let searchFocused = $state(false);
	let searchOrigin = 0;
	let searchBack = false;

	// --- ui state ---------------------------------------------------------------
	let root: HTMLDivElement | undefined = $state();
	let viewport: HTMLDivElement | undefined = $state();
	let searchInput: HTMLInputElement | undefined = $state();
	let menuEl: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let viewportH = $state(400);
	let pending = $state<string | null>(null);
	let pendingTimer: ReturnType<typeof setTimeout> | undefined;
	let toast = $state<{ text: string; ok: boolean } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	let menu = $state<{ x: number; y: number; n: number } | null>(null);
	let help = $state(false);

	const first = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN));
	const last = $derived(Math.min(rows.length, Math.ceil((scrollTop + viewportH) / rowHeight) + OVERSCAN));
	const visible = $derived.by(() => {
		const out: number[] = [];
		for (let i = first; i < last; i++) out.push(i);
		return out;
	});
	// ARIA id references must point at elements that exist: the match list is only
	// rendered while searching, and rows are virtualized.
	const matchesOpen = $derived(searchFocused && query !== '' && matches.length > 0);
	const cursorRendered = $derived(visible.some((i) => rows.node[i] === cursor && rows.close[i] !== 1));

	// New value: reset per-document state.
	$effect(() => {
		tree;
		untrack(() => {
			cursor = carriedCursor;
			matchPos = -1;
			fullStrings.clear();
		});
	});

	// Keep the cursor visible when it moves, rows change, or the mode flips.
	let lastMode: ViewMode | null = null;
	$effect(() => {
		const n = cursor;
		const m = mode;
		rows;
		untrack(() => {
			const center = lastMode !== null && lastMode !== m;
			lastMode = m;
			ensureVisible(n, center);
		});
	});

	$effect(() => {
		const n = cursor;
		const t = tree;
		if (n < t.size) untrack(() => onselect?.(pathOf(t, n), t.values[n]));
	});

	function ensureVisible(n: number, center = false) {
		if (!viewport) return;
		const r = rows.rowOf[n] ?? -1;
		if (r < 0) return;
		const top = r * rowHeight;
		const h = viewport.clientHeight;
		const st = viewport.scrollTop;
		if (center) viewport.scrollTop = Math.max(0, top - h / 2 + rowHeight / 2);
		else if (top < st) viewport.scrollTop = top;
		else if (top + rowHeight > st + h) viewport.scrollTop = top + rowHeight - h;
		scrollTop = viewport.scrollTop;
	}

	// --- helpers ------------------------------------------------------------------
	const isExpanded = (n: number) => rev >= 0 && tree.expanded[n] === 1;
	const isLast = (n: number) => n === 0 || tree.sibling[n] === tree.count[tree.parent[n]!]! - 1;
	const pathText = (n: number) => (n === 0 ? rootLabel : formatPath(pathOf(tree, n)));

	function childKeys(n: number, max = 3): string {
		const keys: string[] = [];
		for (let c = n + 1; c < tree.end[n]! && keys.length < max; c = tree.end[c]!) keys.push(String(tree.keys[c]));
		return keys.join(', ') + (tree.count[n]! > max ? ', …' : '');
	}

	function truncated(n: number): { text: string; more: number } {
		const raw = displayValue(tree.values[n], tree.kinds[n]!);
		// Rows are one line high: show control characters escaped (\n, \t, …) like JSON does.
		const s = tree.kinds[n] === 'string' ? JSON.stringify(raw).slice(1, -1) : raw;
		if (fullStrings.has(n) || s.length <= maxStringLength) return { text: s, more: 0 };
		return { text: s.slice(0, maxStringLength), more: s.length - maxStringLength };
	}

	function sizeLabel(n: number): string {
		const c = tree.count[n]!;
		if (tree.kinds[n] === 'array') return `${c} ${c === 1 ? 'item' : 'items'}`;
		return `${c} ${c === 1 ? 'key' : 'keys'}`;
	}

	function focusTree() {
		viewport?.focus({ preventScroll: true });
	}

	function select(n: number) {
		cursor = n;
	}

	function setExpanded(n: number, open: boolean) {
		if (!hasChildren(tree, n)) return;
		tree.expanded[n] = open ? 1 : 0;
		bump();
	}

	/** After collapsing, move the cursor to its nearest visible ancestor. */
	function fixCursor() {
		let m = cursor;
		while (m > 0 && (rows.rowOf[m] ?? -1) < 0) m = tree.parent[m]!;
		cursor = m;
	}

	function moveRows(delta: number) {
		let r = rows.rowOf[cursor] ?? 0;
		const step = delta > 0 ? 1 : -1;
		let left = Math.abs(delta);
		let target = cursor;
		while (left > 0) {
			r += step;
			if (r < 0 || r >= rows.length) break;
			if (rows.close[r]) continue;
			target = rows.node[r]!;
			left--;
		}
		cursor = target;
	}

	function lastOpenRow(): number {
		for (let r = rows.length - 1; r >= 0; r--) if (!rows.close[r]) return rows.node[r]!;
		return 0;
	}

	function goToMatch(i: number) {
		if (!matches.length) return;
		matchPos = ((i % matches.length) + matches.length) % matches.length;
		const n = matches[matchPos]!;
		if (reveal(tree, n)) bump();
		cursor = n;
	}

	function nextMatch(dir: 1 | -1) {
		if (!matches.length) {
			if (query) showToast('No matches', false);
			return;
		}
		if (dir > 0) {
			const i = matches.findIndex((m) => m > cursor);
			goToMatch(i < 0 ? 0 : i);
		} else {
			let i = -1;
			for (let k = matches.length - 1; k >= 0; k--)
				if (matches[k]! < cursor) {
					i = k;
					break;
				}
			goToMatch(i < 0 ? matches.length - 1 : i);
		}
	}

	function onQueryInput() {
		// Incremental: jump to the first match at/after (or before, for C-r) where the search started.
		if (!matches.length) {
			matchPos = -1;
			return;
		}
		let i: number;
		if (searchBack) {
			i = -1;
			for (let k = matches.length - 1; k >= 0; k--)
				if (matches[k]! <= searchOrigin) {
					i = k;
					break;
				}
			if (i < 0) i = matches.length - 1;
		} else {
			i = matches.findIndex((m) => m >= searchOrigin);
			if (i < 0) i = 0;
		}
		goToMatch(i);
	}

	async function openSearch(back = false) {
		searchBack = back;
		searchOrigin = cursor;
		await tick();
		searchInput?.focus();
		searchInput?.select();
	}

	function onSearchKey(e: KeyboardEvent) {
		const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
		if (e.key === 'Enter') {
			e.preventDefault();
			if (matches.length && matchPos < 0) goToMatch(0);
			else if (matches.length) nextMatch(e.shiftKey ? -1 : 1);
			if (!e.shiftKey || !matches.length) focusTree();
		} else if (e.key === 'ArrowDown' || (ctrl && e.key === 's')) {
			e.preventDefault();
			nextMatch(1);
		} else if (e.key === 'ArrowUp' || (ctrl && e.key === 'r')) {
			e.preventDefault();
			nextMatch(-1);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			query = '';
			matchPos = -1;
			focusTree();
		} else if (ctrl && e.key === 'g') {
			e.preventDefault();
			query = '';
			matchPos = -1;
			cursor = searchOrigin;
			focusTree();
		}
	}

	function showToast(text: string, ok = true) {
		toast = { text, ok };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 1600);
	}

	async function copy(kind: 'value' | 'path' | 'pointer' | 'subtree' | 'document', n = cursor) {
		const text =
			kind === 'value'
				? copyableValue(tree, n)
				: kind === 'path'
					? pathText(n)
					: kind === 'pointer'
						? toPointer(pathOf(tree, n))
						: kind === 'subtree'
							? safeStringify(tree.values[n])
							: safeStringify(tree.root);
		const label = { value: 'value', path: 'path', pointer: 'JSON Pointer', subtree: 'subtree JSON', document: 'document' }[
			kind
		];
		const ok = await copyText(text);
		showToast(ok ? `Copied ${label}` : 'Copy failed — clipboard unavailable', ok);
	}

	async function openMenu(n: number, clientX?: number, clientY?: number) {
		if (!root) return;
		cursor = n;
		const box = root.getBoundingClientRect();
		let x: number;
		let y: number;
		if (clientX !== undefined && clientY !== undefined) {
			x = clientX - box.left;
			y = clientY - box.top;
		} else {
			const vp = viewport!.getBoundingClientRect();
			const r = rows.rowOf[n] ?? 0;
			x = vp.left - box.left + 24 + (mode === 'structure' ? tree.depth[n]! * INDENT : 48);
			y = vp.top - box.top + r * rowHeight - viewport!.scrollTop + rowHeight;
		}
		menu = { x: Math.min(x, box.width - 220), y: Math.min(y, box.height - 40), n };
		await tick();
		menuEl?.querySelector<HTMLButtonElement>('button')?.focus();
	}

	function closeMenu(refocus = true) {
		menu = null;
		if (refocus) focusTree();
	}

	function onMenuKey(e: KeyboardEvent) {
		const items = [...(menuEl?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || e.key === 'j';
		const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || e.key === 'k';
		if (down || up) {
			e.preventDefault();
			items[(i + (down ? 1 : -1) + items.length) % items.length]?.focus();
		} else if (e.key === 'Escape' || (e.ctrlKey && e.key === 'g')) {
			e.preventDefault();
			closeMenu();
		}
	}

	/** Run a menu item for the menu's node (captured before the menu closes). */
	function menuAction(fn: (n: number) => void) {
		const n = menu?.n ?? cursor;
		closeMenu();
		cursor = n;
		fn(n);
	}

	function run(a: Action) {
		const n = cursor;
		const container = hasChildren(tree, n);
		switch (a) {
			case 'down':
				return moveRows(1);
			case 'up':
				return moveRows(-1);
			case 'pageDown':
				return moveRows(Math.max(1, Math.floor(viewportH / rowHeight) - 1));
			case 'pageUp':
				return moveRows(-Math.max(1, Math.floor(viewportH / rowHeight) - 1));
			case 'top':
				cursor = 0;
				return;
			case 'bottom':
				cursor = lastOpenRow();
				return;
			case 'left':
				if (container && tree.expanded[n]) setExpanded(n, false);
				else if (n > 0) cursor = tree.parent[n]!;
				return;
			case 'right':
				if (container && !tree.expanded[n]) setExpanded(n, true);
				else if (container) cursor = n + 1;
				return;
			case 'toggle':
				if (container) setExpanded(n, !tree.expanded[n]);
				else if (truncated(n).more || fullStrings.has(n)) {
					if (fullStrings.has(n)) fullStrings.delete(n);
					else fullStrings.add(n);
				}
				return;
			case 'open':
				return setExpanded(n, true);
			case 'close':
				if (container && tree.expanded[n]) setExpanded(n, false);
				else if (n > 0) {
					cursor = tree.parent[n]!;
					setExpanded(cursor, false);
				}
				return;
			case 'openAll':
				setAll(tree, true);
				bump();
				return;
			case 'closeAll':
				setAll(tree, false);
				bump();
				fixCursor();
				return;
			case 'search':
				if (keymap === 'emacs' && searchFocused) return nextMatch(1);
				void openSearch(false);
				return;
			case 'searchBack':
				void openSearch(true);
				return;
			case 'next':
				return nextMatch(1);
			case 'prev':
				return nextMatch(-1);
			case 'yankValue':
				void copy('value');
				return;
			case 'yankPath':
				void copy('path');
				return;
			case 'yankPointer':
				void copy('pointer');
				return;
			case 'yankSubtree':
				void copy('subtree');
				return;
			case 'yankDocument':
				void copy('document');
				return;
			case 'mode':
				mode = mode === 'structure' ? 'source' : 'structure';
				return;
			case 'menu':
				void openMenu(n);
				return;
			case 'help':
				help = !help;
				return;
			case 'cancel':
				if (help) help = false;
				else if (menu) closeMenu();
				else if (query) {
					query = '';
					matchPos = -1;
				}
				return;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		const wasY = pending === 'y';
		clearTimeout(pendingTimer);
		const res = resolveKey(e, keymap, pending);
		pending = res.pending;
		if (res.handled) e.preventDefault();
		if (res.action) run(res.action);
		if (wasY && !res.handled) {
			// `y` followed by an unrelated key: yank value was run; now handle the key itself.
			const again = resolveKey(e, keymap, null);
			pending = again.pending;
			if (again.handled) e.preventDefault();
			if (again.action) run(again.action);
		}
		if (pending === 'y') {
			pendingTimer = setTimeout(() => {
				if (pending === 'y') {
					pending = null;
					run('yankValue');
				}
			}, 600);
		} else if (pending) {
			pendingTimer = setTimeout(() => (pending = null), 2000);
		}
	}

	function onWindowPointer(e: PointerEvent) {
		if (menu && menuEl && !menuEl.contains(e.target as Node)) menu = null;
	}

	function rowClick(n: number, e: MouseEvent) {
		select(n);
		if ((e.target as HTMLElement).closest('button')) return;
		focusTree();
	}

	const openBracket = (n: number) => (tree.kinds[n] === 'array' ? '[' : '{');
	const closeBracket = (n: number) => (tree.kinds[n] === 'array' ? ']' : '}');

	function sourceToken(n: number): { text: string; cls: string; more: number } {
		const kind = tree.kinds[n]!;
		if (kind === 'string') {
			const t = truncated(n);
			// A truncated string drops its closing quote; the markup re-adds it after the "+N" pill.
			// t.text is already JSON-escaped (see truncated()).
			return { text: `"${t.text}${t.more ? '' : '"'}`, cls: 'string', more: t.more };
		}
		if (kind === 'other') return { text: JSON.stringify(displayValue(tree.values[n], kind)), cls: 'other', more: 0 };
		return { text: displayValue(tree.values[n], kind), cls: kind, more: 0 };
	}
</script>

{#snippet icon(name: 'up' | 'down' | 'expand' | 'collapse' | 'copy' | 'help' | 'close')}
	<!-- Inline stroke icons (Lucide geometry, ISC) so the component stays dependency-free; buttons carry the accessible name. -->
	<svg class="jv-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
		{#if name === 'up'}<path d="m18 15-6-6-6 6" />
		{:else if name === 'down'}<path d="m6 9 6 6 6-6" />
		{:else if name === 'expand'}<path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" />
		{:else if name === 'collapse'}<path d="m7 20 5-5 5 5" /><path d="m7 4 5 5 5-5" />
		{:else if name === 'copy'}<rect x="8" y="8" width="14" height="14" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		{:else if name === 'help'}<circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />
		{:else}<path d="M18 6 6 18" /><path d="m6 6 12 12" />{/if}
	</svg>
{/snippet}

<svelte:window onpointerdown={onWindowPointer} />

<div
	bind:this={root}
	class="jv {className}"
	style:height
	style:--jv-row-h="{rowHeight}px"
	style:color-scheme={theme === 'auto' ? null : theme}
>
	<div class="jv-toolbar">
		<div class="jv-seg" role="group" aria-label="View mode">
			<button type="button" aria-pressed={mode === 'structure'} onclick={() => (mode = 'structure')}>Structure</button>
			<button type="button" aria-pressed={mode === 'source'} onclick={() => (mode = 'source')}>Source</button>
		</div>
		<div class="jv-search">
			<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
			<input
				bind:this={searchInput}
				bind:value={query}
				type="search"
				spellcheck="false"
				autocomplete="off"
				placeholder={keymap === 'vim' ? 'Search keys  (/)' : 'Search keys  (C-s)'}
				aria-label="Search keys"
				aria-controls={matchesOpen ? `${uid}-matches` : undefined}				oninput={onQueryInput}
				onkeydown={onSearchKey}
				onfocus={() => {
					searchFocused = true;
					if (!query) searchOrigin = cursor;
				}}
				onblur={() => (searchFocused = false)}
			/>
			{#if query}
				<span class="jv-count" aria-live="polite">{matches.length ? `${matchPos + 1}/${matches.length}` : '0/0'}</span>
			{/if}
			<button type="button" class="jv-icon" title="Previous match" aria-label="Previous match" onclick={() => nextMatch(-1)}>{@render icon('up')}</button>
			<button type="button" class="jv-icon" title="Next match" aria-label="Next match" onclick={() => nextMatch(1)}>{@render icon('down')}</button>
			<label class="jv-check" title="Also match primitive values">
				<input type="checkbox" bind:checked={valueSearch} onchange={onQueryInput} />values
			</label>
			{#if matchesOpen}
				<div class="jv-matches" id="{uid}-matches" role="listbox" aria-label="Matches">
					{#each Array.from(matches.subarray(0, 200)) as m, i (m)}
						<button
							type="button"
							role="option"
							aria-selected={i === matchPos}
							class:active={i === matchPos}
							onmousedown={(e) => {
								e.preventDefault();
								goToMatch(i);
							}}
						>
							<span class="jv-mpath">
								{#each highlight(pathText(m), parsed.last) as p, pi (pi)}<span class:hit={p.hit}>{p.text}</span>{/each}
							</span>
							{#if !isContainer(tree.kinds[m]!)}
								<span class="jv-mval">{displayValue(tree.values[m], tree.kinds[m]!).slice(0, 60)}</span>
							{:else}
								<span class="jv-mval">{sizeLabel(m)}</span>
							{/if}
						</button>
					{/each}
					{#if matches.length > 200}<div class="jv-mmore">…and {matches.length - 200} more (n / N to step)</div>{/if}
				</div>
			{/if}
		</div>
		<div class="jv-actions-bar">
			<button type="button" class="jv-icon" title="Expand all" aria-label="Expand all" onclick={() => run('openAll')}>{@render icon('expand')}</button>
			<button type="button" class="jv-icon" title="Collapse all" aria-label="Collapse all" onclick={() => run('closeAll')}>{@render icon('collapse')}</button>
			<button type="button" class="jv-icon" title="Copy document" aria-label="Copy document" onclick={() => copy('document')}>{@render icon('copy')}</button>
			<button type="button" class="jv-icon" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-pressed={help} onclick={() => (help = !help)}>{@render icon('help')}</button>
		</div>
	</div>

	<div
		bind:this={viewport}
		bind:clientHeight={viewportH}
		class="jv-viewport"
		class:source={mode === 'source'}
		role="tree"
		tabindex="0"
		aria-label="{rootLabel} ({mode} view)"
		aria-activedescendant={cursorRendered ? `${uid}-${cursor}` : undefined}
		onkeydown={onKey}
		onscroll={() => (scrollTop = viewport!.scrollTop)}
	>
		<div class="jv-rows" style:height="{rows.length * rowHeight}px">
			<div style:height="{first * rowHeight}px"></div>
			{#each visible as i (i)}
				{@const n = rows.node[i]!}
				{@const closing = rows.close[i] === 1}
				{@const kind = tree.kinds[n]!}
				{@const container = isContainer(kind)}
				{@const open = container && isExpanded(n)}
				{@const key = tree.keys[n]}
				{#if mode === 'structure'}
					<div
						class="jv-row"
						class:cursor={n === cursor}
						class:match={matchFlags[n] === 1}
						id="{uid}-{n}"
						role="treeitem"
						aria-level={tree.depth[n]! + 1}
						aria-expanded={container && tree.count[n]! > 0 ? open : undefined}
						aria-selected={n === cursor}
						aria-setsize={n === 0 ? 1 : tree.count[tree.parent[n]!]}
						aria-posinset={tree.sibling[n]! + 1}
						tabindex="-1"
						onclick={(e) => rowClick(n, e)}
						ondblclick={() => container && setExpanded(n, !open)}
						oncontextmenu={(e) => {
							e.preventDefault();
							void openMenu(n, e.clientX, e.clientY);
						}}
						onkeydown={() => {}}
					>
						<span class="jv-indent" style:width="{tree.depth[n]! * INDENT}px"></span>
						{#if container && tree.count[n]! > 0}
							<button
								type="button"
								class="jv-twisty"
								tabindex="-1"
								aria-hidden="true"
								onclick={() => {
									select(n);
									setExpanded(n, !open);
									focusTree();
								}}>{open ? '▾' : '▸'}</button
							>
						{:else}
							<span class="jv-twisty"></span>
						{/if}
						{#if n === 0}
							<span class="jv-root">{rootLabel}</span>
						{:else if typeof key === 'number'}
							<span class="jv-index">{key}</span>
						{:else if key === ''}
							<span class="jv-key jv-empty-key">""</span>
						{:else}
							<span class="jv-key">
								{#each highlight(String(key), matchFlags[n] ? parsed.last : '') as p, pi (pi)}<span class:hit={p.hit}>{p.text}</span>{/each}
							</span>
						{/if}
						{#if tree.tags[n]}<span class="jv-tag">{tree.tags[n]}</span>{/if}
						<span class="jv-punct">:</span>
						{#if container}
							<span class="jv-summary">{kind === 'array' ? '[' : '{'}{sizeLabel(n)}{kind === 'array' ? ']' : '}'}</span>
							{#if !open && tree.count[n]! > 0 && kind === 'object'}
								<span class="jv-preview">{childKeys(n)}</span>
							{/if}
						{:else}
							{@const t = truncated(n)}
							<span class="jv-val {kind}">
								{#if kind === 'string'}"{/if}{#each highlight(t.text, valueSearch && matchFlags[n] ? query.trim() : '') as p, pi (pi)}<span
										class:hit={p.hit}>{p.text}</span
									>{/each}{#if kind === 'string' && !t.more}"{/if}
							</span>
							{@const hint = describeValue?.(key ?? null, tree.values[n])}
							{#if hint}<span class="jv-hint" data-testid="json-hint">{hint}</span>{/if}
							{#if t.more || fullStrings.has(n)}
								<button
									type="button"
									class="jv-more"
									tabindex="-1"
									onclick={() => (fullStrings.has(n) ? fullStrings.delete(n) : fullStrings.add(n))}
									>{t.more ? `…+${t.more} chars` : 'less'}</button
								>
							{/if}
						{/if}
						<span class="jv-row-actions">
							<button type="button" tabindex="-1" title="Copy value" onclick={() => copy('value', n)}>value</button>
							<button type="button" tabindex="-1" title="Copy path" onclick={() => copy('path', n)}>path</button>
						</span>
					</div>
				{:else}
					<div
						class="jv-row src"
						class:cursor={n === cursor && !closing}
						class:cursor-close={n === cursor && closing}
						class:match={!closing && matchFlags[n] === 1}
						id={closing ? undefined : `${uid}-${n}`}
						role={closing ? 'none' : 'treeitem'}
						aria-level={closing ? undefined : tree.depth[n]! + 1}
						aria-expanded={!closing && container && tree.count[n]! > 0 ? open : undefined}
						aria-selected={closing ? undefined : n === cursor}
						tabindex="-1"
						onclick={(e) => rowClick(n, e)}
						ondblclick={() => container && setExpanded(n, !open)}
						oncontextmenu={(e) => {
							e.preventDefault();
							void openMenu(n, e.clientX, e.clientY);
						}}
						onkeydown={() => {}}
					>
						<span class="jv-gutter">{closing ? tree.closeLine[n] : tree.line[n]}</span>
						<span class="jv-fold">
							{#if !closing && container && tree.count[n]! > 0}
								<button
									type="button"
									tabindex="-1"
									aria-hidden="true"
									onclick={() => {
										select(n);
										setExpanded(n, !open);
										focusTree();
									}}>{open ? '▾' : '▸'}</button
								>
							{/if}
						</span>
						<span class="jv-code" style:padding-left="{tree.depth[n]! * 2}ch">
							{#if closing}
								<span class="jv-punct">{closeBracket(n)}{isLast(n) ? '' : ','}</span>
							{:else}
								{#if n !== 0 && typeof key === 'string'}
									<span class="jv-key"
										>"{#each highlight(key, matchFlags[n] ? parsed.last : '') as p, pi (pi)}<span class:hit={p.hit}
												>{p.text}</span
											>{/each}"</span
									><span class="jv-punct">: </span>
								{/if}
								{#if container}
									{#if tree.count[n] === 0}
										<span class="jv-punct">{openBracket(n)}{closeBracket(n)}{isLast(n) ? '' : ','}</span>
									{:else if open}
										<span class="jv-punct">{openBracket(n)}</span>
									{:else}
										<span class="jv-punct">{openBracket(n)}</span><button
											type="button"
											class="jv-fold-pill"
											tabindex="-1"
											title="Unfold"
											onclick={() => {
												select(n);
												setExpanded(n, true);
											}}>…{sizeLabel(n)}</button
										><span class="jv-punct">{closeBracket(n)}{isLast(n) ? '' : ','}</span>
									{/if}
								{:else}
									{@const tok = sourceToken(n)}
									<span class="jv-val {tok.cls}">{tok.text}</span>{#if tok.more}<button
											type="button"
											class="jv-more"
											tabindex="-1"
											onclick={() => fullStrings.add(n)}>…+{tok.more} chars</button
										><span class="jv-val string">"</span>{/if}<span class="jv-punct">{isLast(n) ? '' : ','}</span>
								{/if}
							{/if}
						</span>
					</div>
				{/if}
			{/each}
		</div>

	</div>

	{#if help}
		<div class="jv-help" role="dialog" aria-label="Keyboard shortcuts">
			<div class="jv-help-head">
				<strong>Keyboard — {keymap}</strong>
				<button type="button" class="jv-icon" aria-label="Close help" onclick={() => (help = false)}>{@render icon('close')}</button>
			</div>
			<dl>
				{#each [...HELP[keymap], ...HELP_COMMON] as h (h.keys)}
					<dt><kbd>{h.keys}</kbd></dt>
					<dd>{h.what}</dd>
				{/each}
			</dl>
		</div>
	{/if}

	<div class="jv-status">
		<span class="jv-status-path" title={pathText(cursor)}>{pathText(cursor)}</span>
		<span class="jv-status-kind">
			{tree.tags[cursor] ?? tree.kinds[cursor]}{isContainer(tree.kinds[cursor]!) ? ` · ${sizeLabel(cursor)}` : ''}
		</span>
		{#if pending}<kbd class="jv-pending">{pending}</kbd>{/if}
		<span class="jv-status-spacer"></span>
		<span class="jv-status-meta">{tree.size.toLocaleString()} nodes · {tree.totalLines.toLocaleString()} lines</span>
	</div>

	{#if menu}
				<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div
			bind:this={menuEl}
			class="jv-menu"
			role="menu"
			style:left="{menu.x}px"
			style:top="{menu.y}px"
			onkeydown={onMenuKey}
		>
			<button type="button" role="menuitem" onclick={() => menuAction((n) => copy('value', n))}>Copy value</button>
			<button type="button" role="menuitem" onclick={() => menuAction((n) => copy('path', n))}>Copy path <code>{keymap === 'vim' ? 'Y' : 'C-u M-w'}</code></button>
			<button type="button" role="menuitem" onclick={() => menuAction((n) => copy('pointer', n))}>Copy JSON Pointer</button>
			<button type="button" role="menuitem" onclick={() => menuAction((n) => copy('subtree', n))}>Copy subtree JSON</button>
			<button type="button" role="menuitem" onclick={() => menuAction((n) => copy('document', n))}>Copy whole document</button>
			{#if hasChildren(tree, menu.n)}
				<hr />
				<button
					type="button"
					role="menuitem"
					onclick={() =>
						menuAction((n) => {
							setAll(tree, true, n);
							bump();
						})}>Expand subtree</button
				>
				<button
					type="button"
					role="menuitem"
					onclick={() =>
						menuAction((n) => {
							setAll(tree, false, n);
							bump();
							fixCursor();
						})}>Collapse subtree</button
				>
			{/if}
		</div>
	{/if}

	{#if toast}
		<div class="jv-toast" class:err={!toast.ok} role="status" aria-live="polite">{toast.text}</div>
	{/if}
</div>

<style>
	.jv {
		--jv-bg: var(--background, #fff);
		--jv-fg: var(--foreground, #18181b);
		--jv-muted: var(--muted, #f4f4f5);
		--jv-muted-fg: var(--muted-foreground, #71717a);
		--jv-border: var(--border, #e4e4e7);
		--jv-accent: var(--accent, #f4f4f5);
		--jv-primary: var(--primary, #18181b);
		--jv-primary-fg: var(--primary-foreground, #fafafa);
		--jv-ring: var(--ring, #a1a1aa);
		--jv-popover: var(--popover, var(--jv-bg));
		--jv-radius: var(--radius, 0.5rem);
		--jv-key: light-dark(#6d28d9, #c4b5fd);
		--jv-string: light-dark(#047857, #6ee7b7);
		--jv-number: light-dark(#1d4ed8, #93c5fd);
		--jv-boolean: light-dark(#b45309, #fcd34d);
		--jv-null: light-dark(#6b7280, #a1a1aa);
		--jv-other: light-dark(#be185d, #f9a8d4);
		--jv-hit: light-dark(#fde68a, #a16207);
		--jv-match-row: light-dark(#fefce8, #2a2410);
		--jv-cursor-row: color-mix(in oklab, var(--jv-primary) 10%, transparent);
		--jv-font: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);

		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 10rem;
		background: var(--jv-bg);
		color: var(--jv-fg);
		border: 1px solid var(--jv-border);
		border-radius: var(--jv-radius);
		font-size: 12.5px;
		overflow: hidden;
	}
	:global(.dark .jv:not(.theme-light .jv)) {
		color-scheme: dark;
	}
	:global(.theme-light .jv) {
		color-scheme: light;
	}

	button {
		font: inherit;
		color: inherit;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
	}

	/* toolbar ------------------------------------------------------------- */
	.jv-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--jv-border);
		background: color-mix(in oklab, var(--jv-muted) 60%, var(--jv-bg));
	}
	.jv-seg {
		display: inline-flex;
		border: 1px solid var(--jv-border);
		border-radius: calc(var(--jv-radius) - 2px);
		overflow: hidden;
	}
	.jv-seg button {
		padding: 0.2rem 0.6rem;
		font-size: 12px;
		color: var(--jv-muted-fg);
	}
	.jv-seg button[aria-pressed='true'] {
		background: var(--jv-primary);
		color: var(--jv-primary-fg);
	}
	.jv-search {
		position: relative;
		flex: 1 1 14rem;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 12rem;
		padding: 0 0.4rem;
		border: 1px solid var(--jv-border);
		border-radius: calc(var(--jv-radius) - 2px);
		background: var(--jv-bg);
	}
	.jv-search:focus-within {
		outline: 2px solid var(--jv-ring);
		outline-offset: -1px;
	}
	.jv-search svg {
		width: 13px;
		height: 13px;
		flex: none;
		fill: none;
		stroke: var(--jv-muted-fg);
		stroke-width: 1.5;
	}
	.jv-search input[type='search'] {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: inherit;
		font: 12px var(--jv-font);
		padding: 0.3rem 0;
	}
	.jv-count {
		font: 11px var(--jv-font);
		color: var(--jv-muted-fg);
		white-space: nowrap;
	}
	.jv-check {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 11px;
		color: var(--jv-muted-fg);
		white-space: nowrap;
		padding-left: 0.25rem;
		border-left: 1px solid var(--jv-border);
	}
	.jv-icon {
		min-width: 1.5rem;
		height: 1.5rem;
		display: inline-grid;
		place-items: center;
		border-radius: 4px;
		color: var(--jv-muted-fg);
	}
	.jv-hint {
		margin-left: 0.5rem;
		color: var(--jv-muted-fg);
		font-style: italic;
	}
	.jv-svg {
		width: 0.95rem;
		height: 0.95rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.jv-icon:hover,
	.jv-icon[aria-pressed='true'] {
		background: var(--jv-accent);
		color: var(--jv-fg);
	}
	.jv-actions-bar {
		display: inline-flex;
		gap: 0.1rem;
	}
	.jv-matches {
		position: absolute;
		z-index: 20;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		max-height: 16rem;
		overflow: auto;
		background: var(--jv-popover);
		border: 1px solid var(--jv-border);
		border-radius: calc(var(--jv-radius) - 2px);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
		padding: 0.2rem;
	}
	.jv-matches button {
		display: flex;
		width: 100%;
		gap: 0.75rem;
		justify-content: space-between;
		padding: 0.2rem 0.4rem;
		border-radius: 4px;
		text-align: left;
		font: 12px var(--jv-font);
	}
	.jv-matches button:hover,
	.jv-matches button.active {
		background: var(--jv-accent);
	}
	.jv-mpath {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.jv-mval {
		color: var(--jv-muted-fg);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 40%;
	}
	.jv-mmore {
		padding: 0.25rem 0.4rem;
		color: var(--jv-muted-fg);
		font-size: 11px;
	}

	/* viewport ------------------------------------------------------------ */
	.jv-viewport {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: auto;
		outline: none;
		font-family: var(--jv-font);
	}
	.jv-viewport:focus-visible {
		box-shadow: inset 0 0 0 2px var(--jv-ring);
	}
	.jv-rows {
		min-width: 100%;
		width: max-content;
	}
	.jv-row {
		display: flex;
		align-items: center;
		height: var(--jv-row-h);
		padding-right: 0.75rem;
		white-space: pre;
		cursor: default;
		line-height: var(--jv-row-h);
	}
	.jv-row:hover {
		background: color-mix(in oklab, var(--jv-accent) 70%, transparent);
	}
	.jv-row.match {
		background: var(--jv-match-row);
	}
	.jv-row.cursor {
		background: var(--jv-cursor-row);
		box-shadow: inset 2px 0 0 var(--jv-primary);
	}
	.jv-row.cursor-close {
		background: color-mix(in oklab, var(--jv-primary) 5%, transparent);
	}
	.jv-indent {
		flex: none;
		align-self: stretch;
		background-image: repeating-linear-gradient(
			to right,
			transparent 0 7px,
			color-mix(in oklab, var(--jv-border) 80%, transparent) 7px 8px,
			transparent 8px 16px
		);
	}
	.jv-twisty {
		flex: none;
		width: 16px;
		text-align: center;
		color: var(--jv-muted-fg);
		font-size: 10px;
	}
	.jv-root {
		font-weight: 600;
		color: var(--jv-muted-fg);
	}
	.jv-key {
		color: var(--jv-key);
	}
	.jv-index {
		color: var(--jv-muted-fg);
	}
	.jv-punct {
		color: var(--jv-muted-fg);
	}
	.jv-row:not(.src) .jv-punct {
		margin-right: 0.5ch;
	}
	.jv-tag {
		margin: 0 0.35rem;
		padding: 0 0.3rem;
		border-radius: 3px;
		font-size: 10px;
		line-height: 1.4;
		background: var(--jv-muted);
		color: var(--jv-muted-fg);
		border: 1px solid var(--jv-border);
	}
	.jv-summary {
		color: var(--jv-muted-fg);
	}
	.jv-preview {
		margin-left: 0.6ch;
		color: var(--jv-muted-fg);
		opacity: 0.7;
		max-width: 40ch;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.jv-val,
	.jv-key,
	.jv-mpath {
		/* keep quotes/punctuation in place around right-to-left text */
		unicode-bidi: isolate;
		direction: ltr;
	}
	.jv-val.string {
		color: var(--jv-string);
	}
	.jv-empty-key {
		color: var(--jv-muted-fg);
		font-style: italic;
	}
	.jv-val.number,
	.jv-val.bigint {
		color: var(--jv-number);
	}
	.jv-val.boolean {
		color: var(--jv-boolean);
	}
	.jv-val.null,
	.jv-val.undefined {
		color: var(--jv-null);
		font-style: italic;
	}
	.jv-val.other {
		color: var(--jv-other);
	}
	.hit {
		background: var(--jv-hit);
		border-radius: 2px;
		color: var(--jv-fg);
	}
	.jv-more,
	.jv-fold-pill {
		margin-left: 0.4ch;
		padding: 0 0.35rem;
		border-radius: 3px;
		font-size: 10.5px;
		line-height: 1.5;
		background: var(--jv-muted);
		color: var(--jv-muted-fg);
		border: 1px solid var(--jv-border);
	}
	.jv-fold-pill {
		margin: 0 0.2ch;
	}
	.jv-row-actions {
		display: none;
		margin-left: 1rem;
		gap: 0.25rem;
	}
	.jv-row:hover .jv-row-actions,
	.jv-row.cursor .jv-row-actions {
		display: inline-flex;
	}
	.jv-row-actions button {
		font-size: 10.5px;
		line-height: 1.5;
		padding: 0 0.35rem;
		border-radius: 3px;
		border: 1px solid var(--jv-border);
		background: var(--jv-bg);
		color: var(--jv-muted-fg);
	}
	.jv-row-actions button:hover {
		color: var(--jv-fg);
	}

	/* source mode */
	.jv-gutter {
		flex: none;
		position: sticky;
		left: 0;
		width: 4.5ch;
		padding-right: 0.75ch;
		text-align: right;
		color: var(--jv-muted-fg);
		opacity: 0.7;
		background: inherit;
		user-select: none;
	}
	.jv-row.src .jv-gutter {
		background: color-mix(in oklab, var(--jv-muted) 70%, var(--jv-bg));
	}
	.jv-fold {
		flex: none;
		width: 14px;
		text-align: center;
		font-size: 10px;
		color: var(--jv-muted-fg);
	}
	.jv-code {
		/* inline, not flex: flex items would drop the space in `": "` */
		display: inline;
		padding-left: 0.25rem;
	}

	/* status -------------------------------------------------------------- */
	.jv-status {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.25rem 0.6rem;
		border-top: 1px solid var(--jv-border);
		font: 11px var(--jv-font);
		color: var(--jv-muted-fg);
		background: color-mix(in oklab, var(--jv-muted) 60%, var(--jv-bg));
		min-width: 0;
	}
	.jv-status-path {
		color: var(--jv-fg);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.jv-status-spacer {
		flex: 1;
	}
	.jv-status-meta,
	.jv-status-kind {
		white-space: nowrap;
	}
	kbd {
		font: 11px var(--jv-font);
		padding: 0 0.3rem;
		border: 1px solid var(--jv-border);
		border-bottom-width: 2px;
		border-radius: 4px;
		background: var(--jv-bg);
		color: var(--jv-fg);
		white-space: nowrap;
	}

	/* overlays ------------------------------------------------------------ */
	.jv-help {
		position: absolute;
		top: 2.75rem;
		right: 0.5rem;
		z-index: 10;
		width: min(26rem, calc(100% - 1rem));
		max-height: calc(100% - 5rem);
		overflow: auto;
		padding: 0.6rem 0.8rem;
		background: var(--jv-popover);
		border: 1px solid var(--jv-border);
		border-radius: var(--jv-radius);
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.15);
		font-family: system-ui, sans-serif;
	}
	.jv-help-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.4rem;
	}
	.jv-help dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.25rem 0.75rem;
		margin: 0;
	}
	.jv-help dd {
		margin: 0;
		color: var(--jv-muted-fg);
	}
	.jv-menu {
		position: absolute;
		z-index: 30;
		min-width: 13rem;
		padding: 0.25rem;
		background: var(--jv-popover);
		border: 1px solid var(--jv-border);
		border-radius: calc(var(--jv-radius) - 2px);
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.18);
	}
	.jv-menu button {
		display: flex;
		align-items: center;
		width: 100%;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.3rem 0.5rem;
		border-radius: 4px;
		text-align: left;
		font-size: 12.5px;
	}
	.jv-menu button:hover,
	.jv-menu button:focus-visible {
		background: var(--jv-accent);
		outline: none;
	}
	.jv-menu code {
		font: 11px var(--jv-font);
		color: var(--jv-muted-fg);
	}
	.jv-menu hr {
		border: 0;
		border-top: 1px solid var(--jv-border);
		margin: 0.25rem 0;
	}
	.jv-toast {
		position: absolute;
		right: 0.75rem;
		bottom: 2.25rem;
		z-index: 40;
		padding: 0.35rem 0.7rem;
		border-radius: calc(var(--jv-radius) - 2px);
		background: var(--jv-primary);
		color: var(--jv-primary-fg);
		font-size: 12px;
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.2);
		pointer-events: none;
	}
	.jv-toast.err {
		background: var(--destructive, #dc2626);
		color: #fff;
	}
</style>
