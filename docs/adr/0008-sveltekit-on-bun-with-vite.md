# 8. SvelteKit on Bun (Vite is the one exception to "no Vite")

Date: 2026-09-28 · Status: accepted

## Decision
The UI is SvelteKit (Svelte 5, runes) with shadcn-svelte and Tailwind v4,
built with Vite because SvelteKit requires it — the only place the
"don't use Vite" guidance in CLAUDE.md is overridden. It runs on Bun:
`bun --bun vite dev` in development and `svelte-adapter-bun` for the build
(`bun build/index.js`). Frontend↔backend calls use SvelteKit **remote
functions** (`kit.experimental.remoteFunctions`) in `src/lib/remote/*.remote.ts`,
validated with TypeBox (via a Standard Schema adapter). The webhook stays a
plain `+server.ts` endpoint because GitHub is not a SvelteKit client.
