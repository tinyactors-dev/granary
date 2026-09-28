<!--
	A table fed by a cursor-paginated remote query (ADR 0051).

	Each loaded page is its own query instance `load(before)`, so every page
	is cached, deduplicated and refreshable like any other query, and the
	first page renders during SSR. "Load more" appends the previous page's
	`nextCursor`. Remount (e.g. `{#key filter}`) to reset.
-->
<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import type { RemoteQuery } from '@sveltejs/kit';
	import type { Page } from '$lib/schemas/api';
	import * as Table from '$lib/components/ui/table/index.js';
	import PagedTablePage from './PagedTablePage.svelte';

	let {
		load,
		header,
		row,
		columns,
		empty = 'Nothing here yet.'
	}: {
		load: (before: string | undefined) => RemoteQuery<Page<T>>;
		header: Snippet;
		row: Snippet<[T]>;
		columns: number;
		empty?: string;
	} = $props();

	let cursors = $state<(string | undefined)[]>([undefined]);
</script>

<div class="bg-card overflow-hidden rounded-xl border">
	<Table.Root>
		<Table.Header>
			<Table.Row class="hover:bg-transparent">{@render header()}</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each cursors as before, i (before ?? '')}
				<PagedTablePage
					query={load(before)}
					{row}
					{columns}
					{empty}
					first={i === 0}
					last={i === cursors.length - 1}
					onmore={(cursor) => cursors.push(cursor)}
				/>
			{/each}
		</Table.Body>
	</Table.Root>
</div>
