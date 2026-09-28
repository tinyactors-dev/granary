/** Sub-navigation of the /ops section (ADR 0141). */
export interface OpsNavItem {
	href: string;
	label: string;
}

export const OPS_NAV: OpsNavItem[] = [
	{ href: '/ops', label: 'Overview' },
	{ href: '/ops/conditions', label: 'Conditions' },
	{ href: '/ops/backups', label: 'Backups' },
	{ href: '/ops/destinations', label: 'Destinations' },
	{ href: '/ops/plans', label: 'Plans' },
	{ href: '/ops/drills', label: 'Restore drills' },
	{ href: '/ops/telemetry', label: 'Telemetry' },
	{ href: '/ops/secrets', label: 'Secrets' },
	{ href: '/ops/settings', label: 'Budgets & config' }
];

export function opsActive(pathname: string, href: string): boolean {
	if (href === '/ops') return pathname === '/ops';
	return pathname === href || pathname.startsWith(href + '/');
}
