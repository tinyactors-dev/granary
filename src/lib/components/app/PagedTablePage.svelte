<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import type { RemoteQuery } from '@sveltejs/kit';
	import type { Page } from '$lib/schemas/api';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ErrorAlert from './ErrorAlert.svelte';

	let {
		query,
		row,
		columns,
		empty,
		first,
		last,
		onmore
	}: {
		query: RemoteQuery<Page<T>>;
		row: Snippet<[T]>;
		columns: number;
		empty: string;
		first: boolean;
		last: boolean;
		onmore: (cursor: string) => void;
	} = $props();
</script>

<!--
	The first page is server-rendered, so its boundary has no `pending`
	snippet (SSR renders `pending` instead of the content). Pages added by
	"Load more" are client-only and show skeleton rows while loading.
-->
{#if first}
	<svelte:boundary>
		{@render content(await query)}
		{#snippet failed(error, reset)}{@render failure(error, reset)}{/snippet}
	</svelte:boundary>
{:else}
	<svelte:boundary>
		{@render content(await query)}
		{#snippet pending()}
			{#each { length: 2 } as _, r (r)}
				<Table.Row class="hover:bg-transparent">
					<Table.Cell colspan={columns}><Skeleton class="h-6 w-full" /></Table.Cell>
				</Table.Row>
			{/each}
		{/snippet}
		{#snippet failed(error, reset)}{@render failure(error, reset)}{/snippet}
	</svelte:boundary>
{/if}

{#snippet content(page: Page<T>)}
	{#each page.items as item, i (i)}
		{@render row(item)}
	{:else}
		{#if first}
			<Table.Row class="hover:bg-transparent">
				<Table.Cell colspan={columns} class="text-muted-foreground py-10 text-center">{empty}</Table.Cell>
			</Table.Row>
		{/if}
	{/each}
	{#if last && page.nextCursor}
		{@const cursor = page.nextCursor}
		<Table.Row class="hover:bg-transparent">
			<Table.Cell colspan={columns} class="py-3 text-center">
				<Button variant="outline" size="sm" onclick={() => onmore(cursor)}>
					<ChevronDownIcon /> Load more
				</Button>
			</Table.Cell>
		</Table.Row>
	{/if}
{/snippet}

{#snippet failure(error: unknown, reset: () => void)}
	<Table.Row class="hover:bg-transparent">
		<Table.Cell colspan={columns} class="whitespace-normal">
			<ErrorAlert
				{error}
				retry={() => {
					void query.refresh();
					reset();
				}}
			/>
		</Table.Cell>
	</Table.Row>
{/snippet}
