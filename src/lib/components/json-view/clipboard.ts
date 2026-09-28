/**
 * Copy text to the clipboard: the async Clipboard API first, then the legacy
 * `execCommand('copy')` fallback (insecure origins, denied permission). Never
 * throws; resolves false when both fail.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the legacy path
	}
	if (typeof document === 'undefined') return false;
	const active = document.activeElement as HTMLElement | null;
	const ta = document.createElement('textarea');
	try {
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.top = '0';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		ta.remove();
		active?.focus({ preventScroll: true });
	}
}
