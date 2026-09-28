/** The package version (bundled at build time from package.json; ADR 0156). */
import pkg from '../../package.json';

export const VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';
