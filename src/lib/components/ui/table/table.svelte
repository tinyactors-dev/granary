<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLTableAttributes } from "svelte/elements";

	/**
	 * `stack` (ADR 0295): below the `md` breakpoint each row renders as a card —
	 * the first cell as the row's title, every other cell as "label: value", the
	 * label taken from the column header. Headers are copied into `data-label`
	 * automatically (also for rows rendered later), so pages only opt in.
	 * A header can opt out of the label with `data-stack-label=""`, a cell can
	 * be hidden on phones with `data-stack="hide"` or span the card with
	 * `data-stack="full"`.
	 */
	let {
		ref = $bindable(null),
		class: className,
		children,
		stack = false,
		...restProps
	}: WithElementRef<HTMLTableAttributes> & { stack?: boolean } = $props();

	function labelCells(table: HTMLTableElement) {
		const heads = [...table.querySelectorAll("thead th")] as HTMLTableCellElement[];
		const labels = heads.flatMap((th) => {
			const text = th.dataset.stackLabel ?? th.textContent?.trim() ?? "";
			return Array.from({ length: th.colSpan || 1 }, () => text);
		});
		for (const row of table.querySelectorAll("tbody tr")) {
			let col = 0;
			for (const cell of (row as HTMLTableRowElement).cells) {
				if (cell.colSpan > 1 && cell.colSpan >= labels.length) cell.dataset.stack ??= "full";
				else if (cell.dataset.label === undefined) cell.dataset.label = labels[col] ?? "";
				col += cell.colSpan || 1;
			}
		}
	}

	$effect(() => {
		const table = ref as HTMLTableElement | null;
		if (!stack || !table) return;
		labelCells(table);
		const observer = new MutationObserver(() => labelCells(table));
		observer.observe(table, { childList: true, subtree: true });
		return () => observer.disconnect();
	});
</script>

<div data-slot="table-container" data-stack-table={stack ? "" : undefined} class="relative w-full overflow-x-auto">
	<table bind:this={ref} data-slot="table" class={cn("w-full caption-bottom text-sm", className)} {...restProps}>
		{@render children?.()}
	</table>
</div>
