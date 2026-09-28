# 21. shadcn-svelte setup

Date: 2026-09-28 · Status: accepted

## Context
The UI uses shadcn-svelte (CLAUDE.md, ADR 0008). Its CLI (v1.7.0) is
interactive and requires a design-system *preset*; named presets like
`vega` are not accepted by `--preset`, only encoded preset codes.

## Decision
- Initialized with `shadcn-svelte@1.7.0 init --preset bJLYpge --base-color zinc
  --css src/app.css` and aliases `$lib`, `$lib/components`,
  `$lib/components/ui`, `$lib/utils`, `$lib/hooks`. `bJLYpge` encodes
  `{style: vega (classic shadcn look), baseColor: zinc, theme: zinc,
  iconLibrary: lucide, font: inter, radius: default}` (produced with the
  CLI's own `encodePreset`). The one remaining confirm prompt (overwrite
  `app.css` variables) was answered through a pty.
- Configuration is in `components.json`; theme tokens (light + `.dark`) are
  in `src/app.css`, which imports `tailwindcss`, `tw-animate-css`,
  `shadcn-svelte/tailwind.css` and `@fontsource-variable/inter`.
- Components installed under `src/lib/components/ui/`: alert, avatar, badge,
  button, card, dialog, dropdown-menu, input, label, select, separator,
  skeleton, sonner, table, tabs, textarea, tooltip. Import as
  `import { Button } from '$lib/components/ui/button/index.js'` or
  `import * as Card from '$lib/components/ui/card/index.js'`.
- The root layout renders `<Toaster />` (sonner) once.
- More components: `bunx shadcn-svelte@latest add -y <name>` (non-interactive).

## Consequences
Components are vendored source and may be edited. `cn()` comes from the `cn`
package (re-exported by `$lib/utils`), not clsx + tailwind-merge.
