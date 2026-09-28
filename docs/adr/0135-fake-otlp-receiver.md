# 135. The fake OTLP receiver

Date: 2026-09-28 · Status: accepted

## Decision
`POST /otlp/v1/{traces,logs,metrics}` (direct) and `/v1/…` on the exe.dev
proxy fronts. Protobuf and OTLP/JSON; other content types → 415, undecodable
bodies → 400 (so a broken encoder fails loudly in tests). Every accepted batch
is recorded by `collector/main` (newest 2000; state shows the newest 200)
with `via` (`direct`/`exe-token`/`exe-peer`), size, `service.name` and a
summary for assertions: span names (tinyactors `decodeTraces`), log
severity/event/body, metric names (a small protobuf walker in
`otlp/decode.ts`). Success returns an empty `Export*ServiceResponse`
(protobuf) or `{}` (JSON). There is no Loki push API (ADR 103: OTLP only).
