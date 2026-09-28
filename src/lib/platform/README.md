# platform (ADR 0158)

Leaf layer shared by granary (`src/lib/server/**`) and the ops module
(`src/lib/ops/**`). It imports neither — only npm packages, `bun:*`,
`node:*` and leaf schemas under `src/lib/schemas/**`. Enforced by the
ast-grep rule `platform-is-a-leaf`.

- `secrets/` — the encrypted secret store (envelope encryption under the
  master key): `crypto.ts`, `keys.ts` (master key sources, ADR 0157),
  `store.ts` (`EnvelopeSecretStore`, one per database/table), `contract.ts`
  (`PlatformSecrets`). ops wraps it in `src/lib/ops/secrets/store.ts`;
  granary uses it over granary.sqlite's `secrets` table.
