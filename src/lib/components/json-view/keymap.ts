/**
 * Keyboard handling for <JsonView>: turns a keydown (plus a pending prefix
 * such as vim's `g`/`z`/`y` or emacs' `C-u`/`C-c`) into an action.
 */

export type Keymap = 'vim' | 'emacs';

export type Action =
	| 'down'
	| 'up'
	| 'left'
	| 'right'
	| 'top'
	| 'bottom'
	| 'pageDown'
	| 'pageUp'
	| 'toggle'
	| 'open'
	| 'close'
	| 'openAll'
	| 'closeAll'
	| 'search'
	| 'searchBack'
	| 'next'
	| 'prev'
	| 'yankValue'
	| 'yankPath'
	| 'yankPointer'
	| 'yankSubtree'
	| 'yankDocument'
	| 'mode'
	| 'menu'
	| 'help'
	| 'cancel';

export interface KeyResult {
	action?: Action;
	/** Prefix now waiting for its next key (null = none). */
	pending: string | null;
	/** Whether the event was consumed (preventDefault). */
	handled: boolean;
}

const common = (e: KeyboardEvent): Action | undefined => {
	if (e.ctrlKey || e.altKey || e.metaKey) {
		if (e.shiftKey && e.key === 'F10') return 'menu';
		return undefined;
	}
	switch (e.key) {
		case 'ArrowDown':
			return 'down';
		case 'ArrowUp':
			return 'up';
		case 'ArrowLeft':
			return 'left';
		case 'ArrowRight':
			return 'right';
		case 'Home':
			return 'top';
		case 'End':
			return 'bottom';
		case 'PageDown':
			return 'pageDown';
		case 'PageUp':
			return 'pageUp';
		case 'Enter':
		case ' ':
			return 'toggle';
		case 'ContextMenu':
			return 'menu';
		case 'F10':
			return e.shiftKey ? 'menu' : undefined;
		case 'Escape':
			return 'cancel';
		case '?':
			return 'help';
	}
	return undefined;
};

function vim(e: KeyboardEvent, pending: string | null): KeyResult {
	const k = e.key;
	if (pending === 'g') {
		if (k === 'g') return { action: 'top', pending: null, handled: true };
		return { pending: null, handled: true };
	}
	if (pending === 'z') {
		const a = ({ o: 'open', c: 'close', a: 'toggle', R: 'openAll', M: 'closeAll' } as const)[
			k as 'o' | 'c' | 'a' | 'R' | 'M'
		];
		return { action: a, pending: null, handled: true };
	}
	if (pending === 'y') {
		const a = ({ y: 'yankSubtree', p: 'yankPointer', d: 'yankDocument' } as const)[k as 'y' | 'p' | 'd'];
		// Any other key: plain `y` (yank value); the component replays the key.
		return a ? { action: a, pending: null, handled: true } : { action: 'yankValue', pending: null, handled: false };
	}
	if (e.ctrlKey && !e.altKey && !e.metaKey) {
		if (k === 'd') return { action: 'pageDown', pending: null, handled: true };
		if (k === 'u') return { action: 'pageUp', pending: null, handled: true };
		return { pending: null, handled: false };
	}
	if (e.altKey || e.metaKey) return { pending: null, handled: false };
	switch (k) {
		case 'j':
			return { action: 'down', pending: null, handled: true };
		case 'k':
			return { action: 'up', pending: null, handled: true };
		case 'h':
			return { action: 'left', pending: null, handled: true };
		case 'l':
			return { action: 'right', pending: null, handled: true };
		case 'G':
			return { action: 'bottom', pending: null, handled: true };
		case 'g':
		case 'z':
		case 'y':
			return { pending: k, handled: true };
		case 'Y':
			return { action: 'yankPath', pending: null, handled: true };
		case '/':
			return { action: 'search', pending: null, handled: true };
		case 'n':
			return { action: 'next', pending: null, handled: true };
		case 'N':
			return { action: 'prev', pending: null, handled: true };
		case 't':
			return { action: 'mode', pending: null, handled: true };
	}
	const a = common(e);
	return { action: a, pending: null, handled: !!a };
}

function emacs(e: KeyboardEvent, pending: string | null): KeyResult {
	const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
	const meta = e.altKey && !e.ctrlKey && !e.metaKey;
	const k = e.key.toLowerCase();
	if (pending === 'C-c') {
		const a = ({ w: 'yankSubtree', p: 'yankPointer', d: 'yankDocument' } as const)[k as 'w' | 'p' | 'd'];
		return { action: a, pending: null, handled: true };
	}
	if (ctrl && k === 'g') return { action: 'cancel', pending: null, handled: true };
	// Option-modified keys produce symbols on macOS, so match Meta chords by code.
	if (meta && e.code === 'KeyW') {
		return { action: pending === 'C-u' ? 'yankPath' : 'yankValue', pending: null, handled: true };
	}
	if (meta && e.shiftKey && e.code === 'Comma') return { action: 'top', pending: null, handled: true };
	if (meta && e.shiftKey && e.code === 'Period') return { action: 'bottom', pending: null, handled: true };
	if (meta && e.code === 'KeyV') return { action: 'pageUp', pending: null, handled: true };
	if (meta && e.code === 'KeyT') return { action: 'mode', pending: null, handled: true };
	if (ctrl) {
		switch (k) {
			case 'n':
				return { action: 'down', pending: null, handled: true };
			case 'p':
				return { action: 'up', pending: null, handled: true };
			case 'f':
				return { action: 'right', pending: null, handled: true };
			case 'b':
				return { action: 'left', pending: null, handled: true };
			case 'v':
				return { action: 'pageDown', pending: null, handled: true };
			case 's':
				return { action: 'search', pending: null, handled: true };
			case 'r':
				return { action: 'searchBack', pending: null, handled: true };
			case 'u':
				return { pending: 'C-u', handled: true };
			case 'c':
				return { pending: 'C-c', handled: true };
		}
		return { pending: null, handled: false };
	}
	if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab') {
		return { action: 'toggle', pending: null, handled: true };
	}
	const a = common(e);
	// Keep a C-u prefix alive across bare modifier presses.
	if (!a && ['Alt', 'Shift', 'Control', 'Meta'].includes(e.key)) return { pending, handled: false };
	return { action: a, pending: null, handled: !!a };
}

export function resolveKey(e: KeyboardEvent, keymap: Keymap, pending: string | null): KeyResult {
	return keymap === 'emacs' ? emacs(e, pending) : vim(e, pending);
}

export interface HelpEntry {
	keys: string;
	what: string;
}

export const HELP: Record<Keymap, HelpEntry[]> = {
	vim: [
		{ keys: 'j / k', what: 'next / previous row' },
		{ keys: 'h / l', what: 'collapse or go to parent / expand or go to first child' },
		{ keys: 'gg / G', what: 'top / bottom' },
		{ keys: 'Ctrl-d / Ctrl-u', what: 'page down / up' },
		{ keys: 'zo / zc / za', what: 'open / close / toggle node' },
		{ keys: 'zR / zM', what: 'open all / close all' },
		{ keys: '/', what: 'search keys (Enter jumps, Esc returns)' },
		{ keys: 'n / N', what: 'next / previous match' },
		{ keys: 'y', what: 'yank value' },
		{ keys: 'Y', what: 'yank path (dot/bracket)' },
		{ keys: 'yy', what: 'yank subtree as JSON' },
		{ keys: 'yp / yd', what: 'yank JSON Pointer / whole document' },
		{ keys: 't', what: 'toggle structure / source view' },
		{ keys: 'Esc', what: 'clear search / cancel' }
	],
	emacs: [
		{ keys: 'C-n / C-p', what: 'next / previous row' },
		{ keys: 'C-f / C-b', what: 'expand or first child / collapse or parent' },
		{ keys: 'M-< / M->', what: 'top / bottom' },
		{ keys: 'C-v / M-v', what: 'page down / up' },
		{ keys: 'Tab', what: 'toggle node' },
		{ keys: 'C-s / C-r', what: 'incremental search forward / backward' },
		{ keys: 'M-w', what: 'copy value' },
		{ keys: 'C-u M-w', what: 'copy path (dot/bracket)' },
		{ keys: 'C-c w', what: 'copy subtree as JSON' },
		{ keys: 'C-c p / C-c d', what: 'copy JSON Pointer / whole document' },
		{ keys: 'M-t', what: 'toggle structure / source view' },
		{ keys: 'C-g', what: 'cancel (restores position during search)' }
	]
};

export const HELP_COMMON: HelpEntry[] = [
	{ keys: '↑ ↓ ← →', what: 'move / collapse / expand' },
	{ keys: 'Home / End', what: 'top / bottom' },
	{ keys: 'Enter / Space', what: 'toggle node' },
	{ keys: 'Shift-F10 / Menu', what: 'context menu (copy…)' },
	{ keys: '?', what: 'this help' }
];
