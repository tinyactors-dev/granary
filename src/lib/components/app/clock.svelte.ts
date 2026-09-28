/**
 * A shared, lazily ticking clock for relative timestamps (ADR 0052).
 * On the server it is simply `Date.now()`; in the browser it ticks every
 * 10 s while at least one reactive consumer reads it.
 */
import { browser } from '$app/environment';
import { createSubscriber } from 'svelte/reactivity';

let now = Date.now();

const subscribe = createSubscriber((update) => {
	now = Date.now();
	const id = setInterval(() => {
		now = Date.now();
		update();
	}, 10_000);
	return () => clearInterval(id);
});

export function currentTime(): number {
	if (!browser) return Date.now();
	subscribe();
	return now;
}
