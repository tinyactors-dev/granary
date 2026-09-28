/**
 * App-wide JSON viewer preference (ADR 0058): the keymap every JsonBlock
 * uses. Kept in localStorage per viewer (a convenience, not state that must
 * persist); every access is guarded so SSR and blocked storage still work.
 */
import type { Keymap } from '$lib/components/json-view';

const KEY = 'granary.jsonView.keymap';

function load(): Keymap {
	try {
		const v = globalThis.localStorage?.getItem(KEY);
		return v === 'emacs' ? 'emacs' : 'vim';
	} catch {
		return 'vim';
	}
}

class JsonPrefs {
	keymap = $state<Keymap>('vim');
	#loaded = false;

	/** Read the stored preference (call from the browser, e.g. in an effect). */
	hydrate(): void {
		if (this.#loaded) return;
		this.#loaded = true;
		this.keymap = load();
	}

	toggle(): void {
		this.keymap = this.keymap === 'vim' ? 'emacs' : 'vim';
		try {
			globalThis.localStorage?.setItem(KEY, this.keymap);
		} catch {
			/* storage blocked: the choice lasts for this page only */
		}
	}
}

export const jsonPrefs = new JsonPrefs();
