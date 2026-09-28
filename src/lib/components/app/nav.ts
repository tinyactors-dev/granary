/** Main navigation (ADR 0050, restructured in ADR 0291). */
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import ListChecksIcon from '@lucide/svelte/icons/list-checks';
import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
import MoonStarIcon from '@lucide/svelte/icons/moon-star';
import SettingsIcon from '@lucide/svelte/icons/settings';
import WrenchIcon from '@lucide/svelte/icons/wrench';
import type { Component } from 'svelte';

export interface NavItem {
	href: string;
	label: string;
	icon: Component;
	/** Only for admins (and everyone in development mode): the admin section. */
	adminOnly?: boolean;
}

export const NAV: NavItem[] = [
	{ href: '/', label: 'Overview', icon: LayoutDashboardIcon },
	{ href: '/activity', label: 'Activity', icon: ListChecksIcon },
	{ href: '/policy', label: 'Policy', icon: ShieldCheckIcon },
	{ href: '/ops', label: 'Ops', icon: MoonStarIcon },
	{ href: '/settings', label: 'Settings', icon: SettingsIcon },
	{ href: '/admin', label: 'Admin', icon: WrenchIcon, adminOnly: true }
];

export function isActive(pathname: string, href: string): boolean {
	if (href === '/') return pathname === '/';
	// Item detail pages belong to Activity.
	if (href === '/activity' && pathname.startsWith('/issues/')) return true;
	return pathname === href || pathname.startsWith(href + '/');
}
