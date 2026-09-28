/**
 * The admin section (/admin, ADR 0290): what each area may do in this
 * environment. Computed once per process from configuration and development
 * mode (hooks.server.ts), passed to the shell and checked by every remote
 * function behind the section.
 */
export interface AdminCapabilities {
	/** Development mode (`vite dev` or GRANARY_DEV=1). */
	devMode: boolean;
	/** "Log in as" anyone: development mode only. */
	impersonate: boolean;
	/** The DAP debugger (127.0.0.1) and poking actors (send event): development mode or GRANARY_DEBUGGER=1. */
	debugger: boolean;
	/** Simulation services: development mode, or their URL configured explicitly. */
	fakeGithub: boolean;
	fakeInfra: boolean;
	loadgen: boolean;
	/** The JSON API over the ops backend (tests, scripts): development mode only. */
	devApi: boolean;
}

export type AdminCapability = Exclude<keyof AdminCapabilities, 'devMode'>;

export function adminCapabilities(opts: {
	devMode: boolean;
	debugger: boolean;
	simulation: { fakeGithub: boolean; fakeInfra: boolean; loadgen: boolean };
}): AdminCapabilities {
	const dev = opts.devMode;
	return {
		devMode: dev,
		impersonate: dev,
		debugger: dev || opts.debugger,
		fakeGithub: dev || opts.simulation.fakeGithub,
		fakeInfra: dev || opts.simulation.fakeInfra,
		loadgen: dev || opts.simulation.loadgen,
		devApi: dev
	};
}

export const isAdminPath = (pathname: string): boolean => pathname === '/admin' || pathname.startsWith('/admin/');
