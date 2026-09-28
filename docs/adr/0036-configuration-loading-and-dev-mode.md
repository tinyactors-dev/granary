# 36. Configuration loading and dev-mode computation

Date: 2026-09-28 · Status: accepted

## Decision
- `src/lib/schemas/config.ts` `loadConfig(env, {requireSecrets = true})`
  validates the ADR 0005 variables (plus `FAKE_GITHUB_URL`,
  `GRANARY_STUB_BACKEND`, `PORT`, `NODE_ENV`) with TypeBox and returns a
  typed `Config` (URLs without trailing slash, `admins` lower-cased,
  `otlpTracesUrl = OTEL_EXPORTER_OTLP_ENDPOINT + '/v1/traces'` or null,
  ports as numbers). Empty strings count as unset. It throws `ConfigError`
  listing every problem. The four GitHub secrets are required unless
  `requireSecrets: false` (stub backend only).
- `fakeGithubUrl` = `FAKE_GITHUB_URL`, else `http://localhost:${FAKE_GITHUB_PORT ?? 4010}`.
- `isDevMode({dev, env})` = `env.GRANARY_DEV === '1' || (dev && env.NODE_ENV !== 'production')`
  (ADR 0005/0009). `hooks.server.ts` passes `dev` from `$app/environment` and
  stores the result in `locals.devMode` on every request; the DAP server
  starts only when it is true at `init`.
- `isAdminLogin(config, login)` is the single ADMINS check.
