<!--
	Every UI a developer may want to open (ADR 0154): granary's own pages, the
	fakes, and the ops targets (Grafana, storage consoles). Links come from
	server config and the ops configuration, never from hard-coded URLs.
	`compact` renders a sidebar list; otherwise a card grid grouped by kind.
-->
<script lang="ts">
	import type { DevTool } from '$lib/schemas/dev';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { getDevTools } from '$lib/remote/dev.remote';

	let { compact = false, groups }: { compact?: boolean; groups?: DevTool['group'][] } = $props();
	const tools = getDevTools();
	const GROUPS = $derived<DevTool['group'][]>(groups ?? ['granary', 'ops targets', 'fakes']);
	const dot = (up: boolean | null) => (up === null ? 'bg-muted-foreground/40' : up ? 'bg-emerald-500' : 'bg-red-500');
	const title = (up: boolean | null) => (up === null ? 'not probed' : up ? 'reachable' : 'not reachable');
</script>

{#await tools then list}
	{#if compact}
		{#each list.filter((t) => t.external) as t (t.id)}
			<a
				href={t.url}
				target="_blank"
				rel="noreferrer"
				title={`${t.description} — ${title(t.up)}${t.login ? ` — login ${t.login.username} / ${t.login.password}` : ''}`}
				class="text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors"
				data-testid="dev-external-link"
			>
				<span class="size-2 shrink-0 rounded-full {dot(t.up)}" aria-label={title(t.up)}></span>
				<span class="flex-1 truncate">{t.name}</span>
				<ExternalLinkIcon class="size-3.5 opacity-60" />
			</a>
		{/each}
	{:else}
		<div class="grid gap-4 {GROUPS.length > 1 ? 'md:grid-cols-3' : ''}" data-testid="dev-tools">
			{#each GROUPS as group (group)}
				{@const items = list.filter((t) => t.group === group)}
				{#if items.length}
					<div class="grid content-start gap-1">
						<div class="text-muted-foreground px-1 text-xs font-semibold tracking-wide uppercase">{group}</div>
						{#each items as t (t.id)}
							<a
								href={t.url}
								target={t.external ? '_blank' : undefined}
								rel={t.external ? 'noreferrer' : undefined}
								class="hover:bg-accent flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors"
								data-testid="dev-tool"
							>
								<span class="mt-1.5 size-2 shrink-0 rounded-full {dot(t.up)}" title={title(t.up)}></span>
								<span class="min-w-0 flex-1">
									<span class="flex items-center gap-1 text-sm font-medium">{t.name}{#if t.external}<ExternalLinkIcon class="size-3.5 opacity-60" />{/if}</span>
									<span class="text-muted-foreground block truncate text-xs">{t.external ? t.url : t.description}</span>
								</span>
							</a>
							{#if t.login}
								<div class="text-muted-foreground -mt-1 flex flex-wrap items-center gap-1.5 pl-6.5 text-xs" data-testid="dev-tool-login">
									<span>login</span>
									<button type="button" class="bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono" title="Copy username" onclick={() => navigator.clipboard?.writeText(t.login!.username)}>{t.login.username}</button>
									<span>/</span>
									<button type="button" class="bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono" title="Copy password" onclick={() => navigator.clipboard?.writeText(t.login!.password)}>{t.login.password}</button>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
{:catch}
	{#if !compact}<p class="text-muted-foreground text-sm">Could not list tools.</p>{/if}
{/await}
