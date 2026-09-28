/**
 * The process configuration for routes (ADR 0036): the booted runtime's
 * config, or (stub backend / before boot) one loaded from the environment
 * without requiring secrets.
 */
import { env } from '$env/dynamic/private';
import { loadConfig, type Config } from '$lib/schemas/config';
import { getRuntime } from './system';

let fallback: Config | null = null;

export function getConfig(): Config {
	return getRuntime()?.config ?? (fallback ??= loadConfig(env, { requireSecrets: false }));
}
