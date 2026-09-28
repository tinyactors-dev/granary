# fake-infra — stand-ins for R2, OTLP/Grafana and exe.dev's proxy (ADR 0090, 0103)

Owner: C (fake-infra). Not built yet — M0 pins only `schemas.ts` (control API,
state, SSE events). Separate Bun process with its own tinyactors System, one
actor per file in `fake-infra/actors/`, default port 4090 (`FAKE_INFRA_PORT`),
pitchfork daemon `fake-infra`. Must not import granary or ops code
(`mise run check:boundaries`).
