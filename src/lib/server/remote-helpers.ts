/**
 * Shared plumbing for `src/lib/remote/*.remote.ts` (ADR 0031).
 */
import { error } from '@sveltejs/kit';
import { backendErrorStatus, getBackend, isBackendError, type Backend } from './backend';

/**
 * Run `fn(getBackend())`, turning a `BackendError` into an HTTP error with
 * the mapped status and the error's message. Other errors propagate (500).
 */
export async function withBackend<T>(fn: (backend: Backend) => Promise<T>): Promise<T> {
	try {
		return await fn(getBackend());
	} catch (e) {
		if (isBackendError(e)) error(backendErrorStatus(e.code), e.message);
		throw e;
	}
}
