/** Sidebar of the admin section (ADR 0290; was the dev portal, ADR 0076). */
import GaugeIcon from '@lucide/svelte/icons/gauge';
import LogInIcon from '@lucide/svelte/icons/log-in';
import GithubIcon from '@lucide/svelte/icons/git-branch';
import CloudIcon from '@lucide/svelte/icons/cloud';
import ActivityIcon from '@lucide/svelte/icons/activity';
import UsersIcon from '@lucide/svelte/icons/users';
import WaypointsIcon from '@lucide/svelte/icons/waypoints';
import CpuIcon from '@lucide/svelte/icons/cpu';
import BugIcon from '@lucide/svelte/icons/bug';
import ComponentIcon from '@lucide/svelte/icons/component';
import { UI_CATALOG } from '$lib/dev-ui/catalog';
import type { AdminCapabilities, AdminCapability } from '$lib/schemas/admin';
import type { Component } from 'svelte';

export const ADMIN_GROUPS = ['Inspect', 'Simulate', 'Develop'] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

export interface AdminNavItem {
	href: string;
	label: string;
	icon: Component;
	group: AdminGroup;
	/** One line under the page title. */
	description: string;
	/** Only works where this capability is on; shown as "not configured" otherwise. */
	capability?: AdminCapability;
	/** Active only on exact match (for parents of other items). */
	exact?: boolean;
	/** Nested links (UI component previews). */
	children?: { href: string; label: string }[];
}

export const ADMIN_NAV: AdminNavItem[] = [
	{ href: '/admin', label: 'Overview', icon: GaugeIcon, group: 'Inspect', description: 'Runtime, tools and simulation status', exact: true },
	{ href: '/admin/actors', label: 'Actors', icon: CpuIcon, group: 'Inspect', description: 'Resident actors and the inspector' },
	{ href: '/admin/traces', label: 'Traces', icon: WaypointsIcon, group: 'Inspect', description: 'Span trees of recent work' },
	{ href: '/admin/debugger', label: 'Debugger', icon: BugIcon, group: 'Inspect', description: 'Attach a DAP client, send events', capability: 'debugger' },
	{ href: '/admin/github', label: 'Fake GitHub', icon: GithubIcon, group: 'Simulate', description: 'Open issues and PRs as anyone, faults, deliveries', capability: 'fakeGithub' },
	{ href: '/admin/infra', label: 'Fake infra', icon: CloudIcon, group: 'Simulate', description: 'Fake R2, OTLP intake, exe.dev proxy', capability: 'fakeInfra' },
	{ href: '/admin/load', label: 'Load tester', icon: ActivityIcon, group: 'Simulate', description: 'Scenarios, metrics, invariants', capability: 'loadgen', exact: true },
	{ href: '/admin/load/personas', label: 'Personas', icon: UsersIcon, group: 'Simulate', description: 'Who is doing what, and why', capability: 'loadgen' },
	{ href: '/admin/sessions', label: 'Sessions', icon: LogInIcon, group: 'Develop', description: 'Sign in as anyone (development only)', capability: 'impersonate' },
	{
		href: '/admin/ui',
		label: 'Components',
		icon: ComponentIcon,
		group: 'Develop',
		description: 'Component previews and stories',
		children: UI_CATALOG.map((c) => ({ href: `/admin/ui/${c.id}`, label: c.title }))
	}
];

export function adminActive(pathname: string, item: { href: string; exact?: boolean }): boolean {
	if (item.exact) return pathname === item.href;
	return pathname === item.href || pathname.startsWith(item.href + '/');
}

/** Available here? Items without a capability always are. */
export const adminAvailable = (item: AdminNavItem, caps: AdminCapabilities): boolean => !item.capability || caps[item.capability];
