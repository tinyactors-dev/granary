# 56. Actor inspector: snapshots of an actor's inside

Date: 2026-09-28 · Status: accepted

## Context
The actor list showed only a summary row per actor. Developers and admins
want to see what one actor looks like inside: where it is in its
statechart, its data, what is queued for it and which timers are pending.

## Decision
- **Page** `/actors/[family]/[name]` (named actors only). Opened from the
  address link on `/actors` (plus a dialog quick view), from the dev
  console's actor list ("Inspect" + quick view) and from the live actor
  panel on `/issues/[key]` ("Inspect").
- **Remote query** `inspectActor({address})` in `actors.remote.ts`, backed
  by the new `Backend.inspectActor(address): Promise<ActorSnapshot | null>`.
  It is allowed for any signed-in user, and in dev mode without a login,
  matching the dev console. The layout lets `/actors/*` render
  anonymously in dev mode for the same reason. Inspecting **never loads**
  an actor: `system.findActor` only, so a gone actor returns `null`.
- **DTO** `ActorSnapshot extends ActorSummary` (`$lib/schemas/api`). It
  carries capture time, runtime slot/generation, definition inspection
  (id, name, datamodel, binding, state and actor counts, retired),
  published, microstep/position, current event, internal queue, mailbox
  (up to 100, with `awaited`, operator transitions, and a truncated flag),
  delayed sends (due converted from core time to epoch ms, destination,
  I/O type, target, data), invocations, data, completion, the chart
  structure, and the issue key for issue actors. Outputs are typed only,
  as with the other remote DTOs (ADR 0030). The input has a TypeBox schema.
- **JSON-safe copies** (`src/lib/server/inspect/json-safe.ts`):
  - bigint becomes a string, Set becomes `{"$set": [...]}` and Map becomes `{"$map": {...}}`.
  - Date becomes ISO, typed arrays become `[Uint8Array n bytes]`, functions become `[Function name]`.
  - Cycles become `[Circular]`; getters that throw are shown, not propagated.
  - Depth (12), entries (500) and string length (8000) are capped with `…` markers.
  - The UI's `JsonTree` renders `$set`/`$map` as `Set(n)`/`Map(n)`.
- **Chart structure** (`src/lib/server/inspect/charts.ts`): tinyactors'
  public API has no definition export (the debugger uses a private core
  binding, `definition_export`). Instead, a registry maps each family to
  its actor file's pure builder (`issueChart`, `allowlistChart`).
  `chartFor(identity)` rebuilds the `DefinitionSpec`, checks its revision
  equals the running definition's, and converts it to `ChartStructure`. The
  structure has states (kind, initial, entry/exit, invokes) and transitions (event or `always`, targets, guard
  source trimmed to its expression, one-line action summaries such as
  `send github.close via github`), and the actor file as `sourceFile`. It is
  cached per family@revision. Per-element source lines are **not** shown:
  the builder records spans from stack traces of the *running* code, and
  under Vite and in the bundled build they point at transformed lines, not
  the TypeScript source. The spans' `source` index is 0-based. An
  unknown family or a revision mismatch gives `chart: null`, and the UI says
  so. A new actor family must be added to `BUILDERS`.
- **UI** (`src/lib/components/actors/`):
  - `SnapshotView` shows identity, the statechart, the data tree, events and queues, and delayed sends and invocations.
  - `ChartTree` is a nested HTML tree with the active states and the reached final state highlighted; target names jump to their state.
  - `JsonTree` is a collapsible tree.
  - `DataDiff` shows the difference between the frozen and live snapshots: active states, step, and leaf-level data changes.
  - `ActorGone` is the empty state; for issue actors it links to the issue/verdict page.
  - `ActorQuickView` is the dialog.
  - The page has **Live** mode (refresh every 1.5 s, on by default), **Refresh**, and **Capture snapshot**. Capture freezes a copy with a timestamp; the diff card compares it with live, and "Show captured" shows the frozen snapshot in full. The frozen snapshot stays visible after the actor is gone.

## Consequences
- Snapshots are point-in-time reads from core between pump turns. A
  snapshot can show `macrostepInProgress` only when the actor is paused
  inside one (budgets), so most snapshots are between macrosteps.
- The mailbox of a healthy actor is usually empty: mail is delivered in
  the next pump turn. Retries of GitHub effects live in the relay (outbox),
  not in the actor, so an issue actor in `closing` has no delayed sends.
  The issue page shows the outbox row with attempts, next attempt and error.
- Rebuilding the spec from the builder assumes charts are pure functions of
  code. This holds for our actor files, and the revision check guards
  against a changed chart under a running old definition.
