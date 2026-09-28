# 136. Observing fake-infra: request log, counters, SSE

Date: 2026-09-28 · Status: accepted

## Decision
Every request on every surface (s3, otlp, exe-proxy) is appended to a ring of
1000 (`/__control/state` returns the newest 500) with status, bytes in,
credential and fault ids. Counters: successful S3 writes (PUT and multipart
complete), deletes, uploaded bytes, OTLP batches. `GET /__control/events`
streams live events only (state is in `/__control/state`): `s3.request` for
**every** logged request (the pinned event union has no per-surface variant;
use `request.surface`), `otlp.batch`, `fault.fired`, `reset`.
