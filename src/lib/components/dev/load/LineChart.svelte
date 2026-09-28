<!--
  Line chart for scenario time series (ADR 0076, dataviz method):
  2px lines in fixed categorical slots (validated: blue, orange), recessive
  grid, one y-axis, crosshair + one tooltip listing every series, a legend
  for ≥ 2 series plus direct end labels, and a table view.
-->
<script lang="ts">
	import TableIcon from '@lucide/svelte/icons/table';
	import ChartLineIcon from '@lucide/svelte/icons/chart-line';

	export interface Series {
		key: string;
		label: string;
		values: (number | null)[];
	}

	let {
		title,
		subtitle = '',
		x,
		series,
		format = (v: number) => String(Math.round(v)),
		height = 180
	}: {
		title: string;
		subtitle?: string;
		/** Seconds since start. */
		x: number[];
		series: Series[];
		format?: (v: number) => string;
		height?: number;
	} = $props();

	let width = $state(600);
	let hover = $state<number | null>(null);
	let showTable = $state(false);

	const M = { top: 10, right: 64, bottom: 24, left: 44 };
	const innerW = $derived(Math.max(40, width - M.left - M.right));
	const innerH = $derived(height - M.top - M.bottom);

	const xMax = $derived(Math.max(1, x.at(-1) ?? 1));
	const yMax = $derived.by(() => {
		let m = 0;
		for (const s of series) for (const v of s.values) if (v !== null && v > m) m = v;
		return niceMax(m);
	});

	function niceMax(v: number): number {
		if (v <= 0) return 4;
		if (v <= 4) return 4;
		const p = Math.pow(10, Math.floor(Math.log10(v)));
		for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return f * p;
		return 10 * p;
	}

	const sx = (t: number) => M.left + (t / xMax) * innerW;
	const sy = (v: number) => M.top + innerH - (v / yMax) * innerH;

	/** Ticks at a nice step; whole numbers only when the axis is small (counts). */
	const yTicks = $derived.by(() => {
		const raw = yMax / 4;
		const p = Math.pow(10, Math.floor(Math.log10(raw)));
		let step = [1, 2, 2.5, 5, 10].map((f) => f * p).find((v) => v >= raw) ?? raw;
		if (yMax <= 8) step = Math.max(1, Math.round(step));
		const out: number[] = [];
		for (let v = 0; v <= yMax + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
		return out;
	});
	const xTicks = $derived.by(() => {
		const n = Math.max(2, Math.min(6, Math.floor(innerW / 90)));
		return Array.from({ length: n + 1 }, (_, i) => (i / n) * xMax);
	});

	const fmtT = (t: number) => (t >= 60 ? `${Math.floor(t / 60)}m${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`);

	function path(values: (number | null)[]): string {
		let d = '';
		let pen = false;
		for (let i = 0; i < values.length; i++) {
			const v = values[i];
			if (v === null || v === undefined || x[i] === undefined) {
				pen = false;
				continue;
			}
			d += `${pen ? 'L' : 'M'}${sx(x[i]!).toFixed(1)},${sy(v).toFixed(1)}`;
			pen = true;
		}
		return d;
	}

	function lastPoint(values: (number | null)[]): { i: number; v: number } | null {
		for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null && values[i] !== undefined) return { i, v: values[i]! };
		return null;
	}

	function onMove(e: PointerEvent) {
		const svg = e.currentTarget as SVGSVGElement;
		const r = svg.getBoundingClientRect();
		const t = ((e.clientX - r.left - M.left) / innerW) * xMax;
		let best = 0;
		let bestD = Infinity;
		for (let i = 0; i < x.length; i++) {
			const d = Math.abs(x[i]! - t);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		hover = x.length ? best : null;
	}

	const tip = $derived.by(() => {
		if (hover === null || x[hover] === undefined) return null;
		const left = sx(x[hover]!);
		return { left, flip: left > width - 160, t: x[hover]!, rows: series.map((s, k) => ({ ...s, k, v: s.values[hover!] ?? null })) };
	});
</script>

<figure class="viz-root bg-card rounded-lg border p-3" aria-label={title}>
	<figcaption class="mb-1 flex items-start justify-between gap-2">
		<div>
			<div class="text-sm font-medium">{title}</div>
			{#if subtitle}<div class="text-muted-foreground text-xs">{subtitle}</div>{/if}
		</div>
		<div class="flex items-center gap-3">
			{#if series.length >= 2}
				<ul class="text-muted-foreground flex flex-wrap gap-x-3 text-xs" aria-label="Legend">
					{#each series as s, k (s.key)}
						<li class="flex items-center gap-1.5">
							<span class="inline-block h-0.5 w-3 rounded" style="background: var(--series-{k + 1})"></span>{s.label}
						</li>
					{/each}
				</ul>
			{/if}
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground rounded p-1"
				onclick={() => (showTable = !showTable)}
				aria-pressed={showTable}
				title={showTable ? 'Show chart' : 'Show table'}
			>
				{#if showTable}<ChartLineIcon class="size-4" />{:else}<TableIcon class="size-4" />{/if}
			</button>
		</div>
	</figcaption>

	{#if showTable}
		<div class="max-h-56 overflow-auto text-xs">
			<table class="w-full tabular-nums">
				<thead class="text-muted-foreground sticky top-0 bg-card text-left">
					<tr><th class="py-1 pr-3 font-medium">t</th>{#each series as s (s.key)}<th class="py-1 pr-3 font-medium">{s.label}</th>{/each}</tr>
				</thead>
				<tbody>
					{#each x.map((t, i) => ({ t, i })).reverse().slice(0, 300) as row (row.i)}
						<tr class="border-t">
							<td class="py-0.5 pr-3">{fmtT(row.t)}</td>
							{#each series as s (s.key)}<td class="py-0.5 pr-3">{s.values[row.i] === null || s.values[row.i] === undefined ? '—' : format(s.values[row.i]!)}</td>{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="relative w-full min-w-0 overflow-hidden" bind:clientWidth={width}>
			{#if x.length < 2}
				<div class="text-muted-foreground flex items-center justify-center text-xs" style="height: {height}px">
					Waiting for samples…
				</div>
			{:else}
				<svg
					{width}
					{height}
					role="img"
					aria-label="{title}: {series.map((s) => `${s.label} ${format(lastPoint(s.values)?.v ?? 0)}`).join(', ')}"
					onpointermove={onMove}
					onpointerleave={() => (hover = null)}
					class="block max-w-full touch-none select-none"
				>
					{#each yTicks as v (v)}
						<line x1={M.left} x2={M.left + innerW} y1={sy(v)} y2={sy(v)} class="stroke-border" stroke-width="1" />
						<text x={M.left - 6} y={sy(v)} dy="0.32em" text-anchor="end" class="fill-muted-foreground text-[10px] tabular-nums">{format(v)}</text>
					{/each}
					{#each xTicks as t (t)}
						<text x={sx(t)} y={height - 6} text-anchor="middle" class="fill-muted-foreground text-[10px] tabular-nums">{fmtT(t)}</text>
					{/each}
					{#each series as s, k (s.key)}
						<path d={path(s.values)} fill="none" stroke="var(--series-{k + 1})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
						{@const lp = lastPoint(s.values)}
						{#if lp && series.length <= 4}
							<text x={sx(x[lp.i]!) + 6} y={sy(lp.v)} dy="0.32em" class="fill-foreground text-[10px] font-medium tabular-nums">{format(lp.v)} <tspan class="fill-muted-foreground font-normal">{s.label}</tspan></text>
						{/if}
					{/each}
					{#if tip}
						<line x1={tip.left} x2={tip.left} y1={M.top} y2={M.top + innerH} class="stroke-muted-foreground/60" stroke-width="1" />
						{#each tip.rows as r (r.key)}
							{#if r.v !== null}
								<circle cx={tip.left} cy={sy(r.v)} r="4" fill="var(--series-{r.k + 1})" class="stroke-card" stroke-width="2" />
							{/if}
						{/each}
					{/if}
				</svg>
				{#if tip}
					<div
						class="bg-popover text-popover-foreground pointer-events-none absolute top-1 z-10 rounded-md border px-2 py-1.5 text-xs shadow-md"
						style="left: {tip.flip ? tip.left - 12 : tip.left + 12}px; transform: translateX({tip.flip ? '-100%' : '0'})"
					>
						<div class="text-muted-foreground mb-0.5">{fmtT(tip.t)}</div>
						{#each tip.rows as r (r.key)}
							<div class="flex items-center gap-1.5 whitespace-nowrap">
								<span class="inline-block size-2 rounded-full" style="background: var(--series-{r.k + 1})"></span>
								<strong class="tabular-nums">{r.v === null ? '—' : format(r.v)}</strong>
								<span class="text-muted-foreground">{r.label}</span>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</figure>

<style>
	.viz-root {
		--series-1: #2a78d6;
		--series-2: #eb6834;
		--series-3: #1baf7a;
	}
	:global(.dark .viz-root:not(.theme-light .viz-root)) {
		--series-1: #3987e5;
		--series-2: #d95926;
		--series-3: #199e70;
	}
</style>
