# 132. R2 fidelity toggles

Date: 2026-09-28 · Status: accepted

## Decision
`PUT /__control/fidelity` accepts the full `FidelityRequest` **or any subset
of its keys** (merged; additive leniency — the pinned schema is used via
`Type.Partial`). Semantics:

| Toggle (default) | On | Off |
|---|---|---|
| `sigV4` (on) | verify signatures | accept anything, treat as admin |
| `regionAuto` (on) | scope region must be `auto`, `us-east-1` or empty (else `AuthorizationHeaderMalformed`) | any region |
| `conditionalWrites` (on) | honour `If-None-Match: *` / `If-Match` on writes | ignore them (overwrite) |
| `conditionalOnPresigned` (on) | honour the unsigned `If-None-Match` on presigned PUTs | ignore it on presigned requests — simulates R2 *not* honouring it, to test the check-then-upload fallback (ADR 108) |
| `equalPartSizes` (on) | multipart complete requires equal non-trailing parts and a trailing part no larger → `InvalidPart` | S3 rules only |
| `perKeyWriteRateLimit` (off) | a second write to the same key within 1 s → 429 `SlowDown` | no limit |
| `r2NotImplemented` (on) | `?versioning`, `?object-lock`, `?retention`, `?legal-hold`, `?versions`, `?versionId` → 501 `NotImplemented` | GET `?versioning` → empty config (never enabled) |
