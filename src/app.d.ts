// See https://svelte.dev/docs/kit/types#app.d.ts
import type { SessionUser } from '$lib/schemas/api';

declare global {
	namespace App {
		// interface Error {}
		/** Filled by hooks.server.ts `handle` on every request (ADR 0031, ADR 0034). */
		interface Locals {
			/** The signed-in user, or null. `isAdmin` is computed from ADMINS per request. */
			user: SessionUser | null;
			/** The resolved `granary_session` cookie value, or null. */
			sessionId: string | null;
			/** `isDevMode({ dev, env })` (ADR 0005/0009). Gates /__dev and dev remote functions. */
			devMode: boolean;
			/** First-run state (ADR 0161): `needs-github` until a GitHub connection exists. */
			setupState: import('$lib/schemas/admins').SetupState;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
