
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

---

# Project guidelines (granary)

granary listens to GitHub `issues` webhooks and auto-closes issues opened by
users who are not on an allowlist. It is built on `@tinyactors/node`
(statechart actors) with an application-level SQLite write-ahead log.
Decisions live in `docs/adr/`, one ADR per file — read them before changing
architecture, and add a new ADR for every new decision.

## Coding guidelines

- **One file per actor.** Each actor's statechart (definition + its data type)
  lives in its own file under `src/lib/server/actors/` (main system) or
  `fake-github/actors/` (fake GitHub).
- **No unit tests.** Tests always run against a running system (the app, the
  fake GitHub, and an OTLP collector started by the test harness).
- **Observe through OpenTelemetry traces.** tinyactors exports OTLP traces
  (`System.setTraceSink`, `decodeTraces`); tests assert on and observe system
  properties via those traces rather than reaching into internals.
- **Fake GitHub.** A separate system (`fake-github/`) emulates the subset of
  GitHub we use (REST, webhooks, OAuth) so things can be tested interactively
  and automatically.
- **`/__dev` route** exists only in development: log somebody in
  automatically, trigger actions (e.g. open an issue on the fake GitHub as any
  user), and attach a DAP debugger to the running actor system.
- **UI:** SvelteKit + shadcn-svelte (https://github.com/huntabyte/shadcn-svelte).
  Frontend/backend communication uses SvelteKit remote functions.
- **Schemas:** `@sinclair/typebox` at every serialization boundary (webhooks,
  GitHub REST, remote functions, SQLite JSON columns, fake-GitHub control API).
- **Bun first:** `bun:sqlite` for SQLite; prefer Bun APIs/libraries whenever
  possible. (Exception: SvelteKit requires Vite — see ADR.)
- **Tasks** are mise tasks (`mise.toml`). Secrets come from fnox; never
  hardcode real secrets.
- **Commits:** Conventional Commits, linear history.
- **Interactive verification in a browser uses `agent-browser`** (installed via
  mise as `npm:agent-browser`; see `agent-browser --help`). Do not install
  Playwright or download Chromium for checking pages or taking screenshots.
