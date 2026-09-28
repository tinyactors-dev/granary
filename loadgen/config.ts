/** Loadgen environment (ADR 0070). */
export interface LoadgenEnvConfig {
	port: number;
	fakeGithubUrl: string;
	allowlisted: string[];
	granaryLogin: string;
	otlpEndpoint: string | null;
}

const nonEmpty = (v: string | undefined) => (v && v.trim().length ? v.trim() : undefined);

export function loadgenConfig(env: Record<string, string | undefined> = process.env): LoadgenEnvConfig {
	const fakePort = nonEmpty(env.FAKE_GITHUB_PORT) ?? '4010';
	return {
		port: Number(nonEmpty(env.LOADGEN_PORT) ?? 4040),
		fakeGithubUrl: (nonEmpty(env.FAKE_GITHUB_URL) ?? `http://localhost:${fakePort}`).replace(/\/+$/, ''),
		allowlisted: (nonEmpty(env.LOADGEN_ALLOWLISTED) ?? 'alice')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
		granaryLogin: nonEmpty(env.LOADGEN_GRANARY_LOGIN) ?? 'granary[bot]',
		otlpEndpoint: nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? null
	};
}
