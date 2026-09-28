# 23. Enabling remote functions and async Svelte

Date: 2026-09-28 · Status: accepted

## Context
ADR 0008 chooses SvelteKit remote functions. With @sveltejs/kit 2.70.3 and
svelte 5.57.1 both are still experimental and off by default.

## Decision
`svelte.config.js` sets (keys verified against the installed type
declarations, `@sveltejs/kit/types/index.d.ts` `KitConfig.experimental` and
`svelte/types/index.d.ts` `CompileOptions.experimental`):

```js
compilerOptions: { experimental: { async: true } },
kit: { adapter: adapter(), experimental: { remoteFunctions: true } }
```

`async: true` lets components `await` remote queries directly in markup and
`<svelte:boundary>` handle pending states.

## Consequences
Both flags are outside semver; kit/svelte upgrades must be checked against
their changelogs for remote-function API changes.
