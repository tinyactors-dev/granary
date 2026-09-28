import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import InboxIcon from '@lucide/svelte/icons/inbox';
import SendIcon from '@lucide/svelte/icons/send';
import GavelIcon from '@lucide/svelte/icons/gavel';
import UserCheckIcon from '@lucide/svelte/icons/user-check';
import CpuIcon from '@lucide/svelte/icons/cpu';
import BugIcon from '@lucide/svelte/icons/bug';
import MoonStarIcon from '@lucide/svelte/icons/moon-star';
import type { Component } from 'svelte';

export interface NavItem {
	href: string;
	label: string;
	icon: Component;
	description: string;
	devOnly?: boolean;
}

export const NAV: NavItem[] = [
	{ href: '/', label: 'Overview', icon: LayoutDashboardIcon, description: 'System at a glance' },
	{ href: '/deliveries', label: 'Deliveries', icon: InboxIcon, description: 'Webhook inbox' },
	{ href: '/effects', label: 'Effects', icon: SendIcon, description: 'GitHub outbox' },
	{ href: '/verdicts', label: 'Verdicts', icon: GavelIcon, description: 'Decisions per issue' },
	{ href: '/allowlist', label: 'Allowlist', icon: UserCheckIcon, description: 'Who may open issues' },
	{ href: '/actors', label: 'Actors', icon: CpuIcon, description: 'Resident actors' },
	{ href: '/ops', label: 'Ops', icon: MoonStarIcon, description: 'Backups, telemetry and self-healing' },
	{ href: '/__dev', label: 'Dev', icon: BugIcon, description: 'Developer console', devOnly: true }
];

export function isActive(pathname: string, href: string): boolean {
	if (href === '/') return pathname === '/';
	if (href === '/deliveries' && pathname.startsWith('/issues/')) return false;
	return pathname === href || pathname.startsWith(href + '/');
}
