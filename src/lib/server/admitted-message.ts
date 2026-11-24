/**
 * The comment granary posts on each item it reopens when an admin lets the
 * author in from Activity (ADR 0314): stored as the `messages.admitted`
 * setting, rendered when the reopen is queued.
 */
import type { Database } from 'bun:sqlite';
import { ADMITTED_MESSAGE_SETTING, DEFAULT_ADMITTED_TEMPLATE, renderAdmitted, validateAdmittedTemplate, type AdmittedContext } from '../schemas/message-template';
import { AdminStore, AdminStoreError } from './admins';
import { log } from './log';

/** The template in effect: the stored one, or the built-in default. */
export function readAdmittedTemplate(db: Database): { template: string; custom: boolean } {
	const s = new AdminStore(db).getSetting(ADMITTED_MESSAGE_SETTING);
	if (s && typeof s.value === 'string' && validateAdmittedTemplate(s.value).length === 0) return { template: s.value, custom: true };
	return { template: DEFAULT_ADMITTED_TEMPLATE, custom: false };
}

/** Save the template (`null` = back to the default); throws AdminStoreError('invalid'). */
export function saveAdmittedTemplate(db: Database, template: string | null, by: string): { template: string; custom: boolean } {
	if (template !== null) {
		const problems = validateAdmittedTemplate(template);
		if (problems.length) throw new AdminStoreError('invalid', problems.map((p) => p.message).join('; '));
	}
	new AdminStore(db).setSetting(ADMITTED_MESSAGE_SETTING, template, 'ui', by, { action: 'config.set', details: { key: ADMITTED_MESSAGE_SETTING, custom: template !== null } });
	return readAdmittedTemplate(db);
}

/** The comment, from the template in effect now; falls back to the default if it fails. */
export function renderAdmittedComment(db: Database, ctx: AdmittedContext): string {
	const { template } = readAdmittedTemplate(db);
	try {
		return renderAdmitted(template, ctx);
	} catch (e) {
		log.warn(`admitted: the comment template failed to render (${(e as Error).message}); using the default`);
		return renderAdmitted(DEFAULT_ADMITTED_TEMPLATE, ctx);
	}
}
