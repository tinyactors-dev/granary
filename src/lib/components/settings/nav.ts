import type { AuditAction } from '$lib/schemas/admins';
/** Sub-navigation of the /settings section (ADR 0210). */
export interface SettingsNavItem {
	href: string;
	label: string;
	adminOnly?: boolean;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
	{ href: '/settings', label: 'General' },
	{ href: '/settings/github', label: 'GitHub' },
	{ href: '/settings/admins', label: 'Admins' },
	{ href: '/settings/login-links', label: 'Login links', adminOnly: true },
	{ href: '/settings/audit', label: 'Audit log', adminOnly: true }
];

export function settingsActive(pathname: string, href: string): boolean {
	if (href === '/settings') return pathname === '/settings';
	return pathname === href || pathname.startsWith(href + '/');
}

/** Login-link lifetimes offered in the UI, in minutes (schema allows 1 min … 24 h). */
export const LOGIN_LINK_TTL_CHOICES: { minutes: number; label: string }[] = [
	{ minutes: 15, label: '15 minutes' },
	{ minutes: 60, label: '1 hour' },
	{ minutes: 240, label: '4 hours' },
	{ minutes: 1440, label: '24 hours' }
];

/** Human labels for audit actions (ADR 0161). */
export const AUDIT_LABELS: Record<AuditAction, string> = {
	'admin.add': 'Admin added',
	'admin.remove': 'Admin removed',
	'login-link.create': 'Sign-in link created',
	'login-link.use': 'Sign-in link used',
	'login-link.revoke': 'Sign-in link revoked',
	'github.app.create': 'GitHub App created',
	'github.mode.set': 'GitHub connection changed',
	'github.disconnect': 'GitHub disconnected',
	'github.logo.dismiss': 'App logo reminder dismissed',
	'github.repo.enable': 'Repository guarded',
	'github.repo.disable': 'Repository no longer guarded',
	'config.set': 'Setting changed',
	'blocklist.add': 'Login blocked',
	'blocklist.remove': 'Login unblocked',
	'closing-message.set': 'Closing message changed'
};
