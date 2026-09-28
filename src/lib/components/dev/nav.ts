/** Sub-navigation of the dev portal (ADR 0076). */
import GaugeIcon from '@lucide/svelte/icons/gauge';
import LogInIcon from '@lucide/svelte/icons/log-in';
import GithubIcon from '@lucide/svelte/icons/git-branch';
import ActivityIcon from '@lucide/svelte/icons/activity';
import UsersIcon from '@lucide/svelte/icons/users';
import WaypointsIcon from '@lucide/svelte/icons/waypoints';
import CpuIcon from '@lucide/svelte/icons/cpu';
import ComponentIcon from '@lucide/svelte/icons/component';
import { UI_CATALOG } from '$lib/dev-ui/catalog';
import type { Component } from 'svelte';

export const DEV_GROUPS = ['Console', 'Load', 'Inspect', 'UI'] as const;
export type DevGroup = (typeof DEV_GROUPS)[number];

export interface DevNavItem {
	href: string;
	label: string;
	icon: Component;
	group: DevGroup;
	description: string;
	/** Active only on exact match (for parents of other items). */
	exact?: boolean;
	/** Nested links (UI component previews). */
	children?: { href: string; label: string }[];
}

export const DEV_NAV: DevNavItem[] = [
	{ href: '/__dev', label: 'Overview', icon: GaugeIcon, group: 'Console', description: 'Status of everything', exact: true },
	{ href: '/__dev/sessions', label: 'Sessions', icon: LogInIcon, group: 'Console', description: 'Log in as anyone' },
	{ href: '/__dev/github', label: 'Fake GitHub', icon: GithubIcon, group: 'Console', description: 'Open issues, faults, deliveries' },
	{ href: '/__dev/load', label: 'Load tester', icon: ActivityIcon, group: 'Load', description: 'Scenarios, metrics, invariants', exact: true },
	{ href: '/__dev/load/personas', label: 'Personas', icon: UsersIcon, group: 'Load', description: 'Who is doing what, and why' },
	{ href: '/__dev/traces', label: 'Traces', icon: WaypointsIcon, group: 'Inspect', description: 'Span trees' },
	{ href: '/__dev/actors', label: 'Actors & debugger', icon: CpuIcon, group: 'Inspect', description: 'DAP, send events, inspector' },
	{
		href: '/__dev/ui',
		label: 'Components',
		icon: ComponentIcon,
		group: 'UI',
		description: 'Component previews and stories',
		children: UI_CATALOG.map((c) => ({ href: `/__dev/ui/${c.id}`, label: c.title }))
	}
];

export const isDevPath = (pathname: string) => pathname === '/__dev' || pathname.startsWith('/__dev/');

export function devActive(pathname: string, item: { href: string; exact?: boolean }): boolean {
	if (item.exact) return pathname === item.href;
	return pathname === item.href || pathname.startsWith(item.href + '/');
}
