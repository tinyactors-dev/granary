# platform (ADR 0158)

Leaf layer shared by granary (`src/lib/server/**`) and the ops module
(`src/lib/ops/**`). It imports neither — only npm packages, `bun:*`,
`node:*` and leaf schemas under `src/lib/schemas/**`. Enforced by the
ast-grep rule `platform-is-a-leaf`.

- `secrets/` — the encrypted secret store (envelope encryption under the
  master key). `contract.ts` is pinned; the implementation moves here from
  `src/lib/ops/secrets/` in fork E1 (ADR 0166).
