# 22. Loading the @tinyactors/node native addon under Vite and adapter-bun

Date: 2026-09-28 · Status: accepted

## Context
`@tinyactors/node` is CommonJS that `require()`s a platform package
(`@tinyactors/node-<os>-<arch>`, a `.node` addon) at load time. Bundling or
Vite dep-pre-bundling would break that lookup.

## Decision
- `@tinyactors/node` stays in `package.json` **`dependencies`**. This is the
  load-bearing part:
  - Vite's SSR build externalizes dependencies it finds in `node_modules`.
  - `svelte-adapter-bun` re-bundles the server with rollup and externalizes
    exactly `Object.keys(pkg.dependencies)` (plus `node:*`). A package in
    `devDependencies` would be inlined and the addon lookup would fail.
- `vite.config.ts` additionally sets `ssr.external` and
  `optimizeDeps.exclude` to `['@tinyactors/node']` as an explicit guard.
  (Verified: build and dev also work without it today; it protects against
  a future `ssr.noExternal` or pre-bundling change.)
- Verified with throwaway `hooks.server.ts` + `+page.server.ts` that create a
  system, spawn a statechart and send an event: works under
  `bun --bun vite dev` and in `bun build/index.js`; the built chunks contain
  `import … from "@tinyactors/node"` resolved from `node_modules` at runtime.

## Consequences
The deployed `build/` needs `node_modules` with production deps installed
(`bun install --production`) for the host's platform. Any other native or
must-not-bundle server dependency must also go in `dependencies`.
