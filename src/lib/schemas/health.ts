/**
 * `/healthz` (liveness) and `/readyz` (readiness) response bodies (ADR 0163).
 * Only `database` and `system` affect readiness; the other checks inform.
 */
import { Type, type Static } from '@sinclair/typebox';

const closed = { additionalProperties: false } as const;

/**
 * `sandbox`: this instance is a sandbox (ADR 0312); production forwards admins
 * only to one that says so, and rewrites `Origin` to the sandbox's own `origin`
 * (its `ORIGIN`, reported only by a sandbox) for SvelteKit's CSRF check (ADR 0315).
 */
export const HealthzResponse = Type.Object(
	{ status: Type.Literal('ok'), version: Type.String(), sandbox: Type.Boolean(), origin: Type.Optional(Type.String()) },
	closed
);
export type HealthzResponse = Static<typeof HealthzResponse>;

const OkFail = Type.Union([Type.Literal('ok'), Type.Literal('fail')]);

export const ReadyzResponse = Type.Object(
	{
		ready: Type.Boolean(),
		version: Type.String(),
		uptimeSeconds: Type.Number({ minimum: 0 }),
		checks: Type.Object(
			{
				database: OkFail,
				system: OkFail,
				masterKey: Type.Union([Type.Literal('ok'), Type.Literal('missing')]),
				github: Type.Union([Type.Literal('ready'), Type.Literal('needs-github'), Type.Literal('error')]),
				ops: Type.Union([Type.Literal('ok'), Type.Literal('attention'), Type.Literal('unavailable')])
			},
			closed
		)
	},
	closed
);
export type ReadyzResponse = Static<typeof ReadyzResponse>;
