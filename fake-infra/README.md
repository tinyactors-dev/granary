# fake-infra — stand-ins for R2, the Grafana OTLP intake and exe.dev's proxy

ADRs 0090, 0103, 0130–0139. A separate Bun process with its own tinyactors
System (one actor per file in `actors/`). Must not import granary or ops code
(`mise run check:boundaries`).

Run: `mise run up` (pitchfork daemon `fake-infra`) or `mise run fake-infra`.
Page: http://localhost:4090/ · dev portal: `/__dev/infra`.

| Surface | URL |
|---|---|
| S3 / R2 (path-style, SigV4, region `auto`) | `http://localhost:4090/s3` · EU jurisdiction: `…/s3/eu` |
| OTLP/HTTP (protobuf + JSON) | `http://localhost:4090/otlp/v1/{traces,logs,metrics}` |
| exe.dev proxy, token front | `http://localhost:4091/v1/…` + `X-Exedev-Authorization: Bearer <token>` |
| exe.dev proxy, peer front | `http://localhost:4092/v1/…` (no auth) |
| control API | `/__control/*` (see `schemas.ts`), SSE on `/__control/events` |

Bun's S3 client against it:

```ts
new Bun.S3Client({ endpoint: 'http://localhost:4090/s3/eu', region: 'auto', bucket: 'granary-backups',
  accessKeyId: '0000000000000000000000000000dev1', secretAccessKey: '000…fakedev1' });
```

Files: `server.ts` (routing, control API), `system.ts`, `actors/`
(settings, credentials, faults, collector, bucket), `s3/` (handler, SigV4,
XML), `otlp/` (handler, decoder), `exe-proxy.ts`, `blobs.ts` (object bytes),
`events.ts` (request log + SSE), `page.ts`.
