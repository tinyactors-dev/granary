# 77. Storybook-style component previews under /__dev/ui

Date: 2026-09-28 · Status: accepted (replaces the ad-hoc playground of ADR 57)

## Context
Components such as the JSON view and the trace viewer need a place to be
developed and reviewed in isolation, with fixed data and every variant,
without the rest of the dev console around them.

## Decision
- A registry, `src/lib/dev-ui/registry.ts`, lists **preview entries**:
  `id`, title, description, source path, a **preview wrapper** that renders
  the component from `args`, an optional **docs** component, **controls**
  (`select | boolean | number | text`) and **stories** (named `args`).
  `src/lib/dev-ui/catalog.ts` repeats only ids and titles for navigation,
  so the app shell does not import preview components.
- Routes: `/__dev/ui` (catalogue) and one generic page
  `/__dev/ui/<component>/[<story>]` (unknown ones 404): stories on the left,
  a clean canvas (neutral checkerboard frame, theme toggle
  app/light/dark, viewport presets fill/1280/768/375), controls on the
  right (reset to the story's args), docs below. Nothing else from the dev
  console appears on these pages.
- Forcing light inside a dark page: `.theme-light` re-declares the light
  theme variables and the Tailwind `dark` variant excludes `.theme-light`
  subtrees; component-scoped dark styles (JSON view, trace viewer, charts)
  follow the same rule.
- First entries:
  - **JSON view** — the former `/__dev/components/json-view` playground:
    its datasets are stories (`src/lib/dev-ui/fixtures/json.ts`), its
    options controls (plus "paste JSON"), its keybinding cheat sheet the
    docs.
  - **Trace viewer** — the explorer is split into the presentational
    `TraceBrowser` (plain data in, selection/expansion state inside) and the
    live `TraceExplorer` (filters, polling, remote queries). Stories render
    `TraceBrowser` from deterministic fixtures in `$lib/trace/fixtures`
    (single issue, error span, missing parent, many traces, empty, loading),
    shared with the stub backend; `summarizeTraces` moved to
    `$lib/trace/summary` so the browser can use it.
- Adding a preview: a wrapper in `src/lib/dev-ui/previews/`, optionally a
  docs component, an entry in the registry, a line in the catalog.
