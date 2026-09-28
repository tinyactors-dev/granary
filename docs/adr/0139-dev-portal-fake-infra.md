# 139. /__dev/infra and the dev Backend seam for fake-infra

Date: 2026-09-28 · Status: accepted

## Decision
- Config: `FAKE_INFRA_URL` (default `http://localhost:4090`) → `config.fakeInfraUrl`.
- Backend (additive, dev only): `getFakeInfraStatus(): FakeInfraInfo` (never
  throws; `reachable: false` when down) and `fakeInfraControl(action)` with a
  TypeBox union `FakeInfraAction` in `$lib/schemas/dev` built from
  `fake-infra/schemas.ts` (reset, create/delete bucket, issue/revoke
  credential, inject/clear faults, fidelity, clock, exe proxy). Real backend:
  `FakeInfraClient` (validates responses with the fake's schemas); stub:
  `StubFakeInfra` with an EU bucket of hourly backups, an open multipart
  upload, credentials, a live fault and traffic.
- Remote functions in `src/lib/remote/infra.remote.ts` (`requireDev()`).
- Page `/__dev/infra` ("Fake infra" in the dev sidebar, Console group):
  endpoints + counters + a copyable env snippet for ops seeds; buckets with
  objects and open uploads; credentials (secret shown once); fidelity, clock
  skew and proxy switches; faults with presets (R2 5xx, auth revoked,
  manifest write fails, Grafana down, proxy 502); traffic (requests and OTLP
  batches). Live refresh every 2 s.
