/** Minimal structured-ish logging for the server side. */
const stamp = () => new Date().toISOString();

function fmt(e: unknown): string {
	if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
	return typeof e === 'string' ? e : JSON.stringify(e);
}

export const log = {
	info(message: string, ...rest: unknown[]): void {
		console.log(`${stamp()} granary ${message}`, ...rest.map(fmt));
	},
	warn(message: string, ...rest: unknown[]): void {
		console.warn(`${stamp()} granary WARN ${message}`, ...rest.map(fmt));
	},
	error(message: string, ...rest: unknown[]): void {
		console.error(`${stamp()} granary ERROR ${message}`, ...rest.map(fmt));
	}
};
