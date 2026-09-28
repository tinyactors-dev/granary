# 142. Calm tone and the "while you were away" banner

Date: 2026-09-28 · Status: accepted · Implements 100, 104

## Decision
- `/ops` leads with one headline: **"Sleeping is fine"** or **"Needs you
  (not urgent)"** (or "Ops isn't running" when inactive), from
  `status().sleepOk` and its reasons. Condition states are worded calmly:
  ok · watching · fixing itself · needs you · acknowledged. No red for
  anything except errors a human caused (e.g. a failed save).
- The banner (`OpsBanner.svelte`) sits in the root layout, above every page,
  for signed-in users outside `/__dev`. It is fed by `getOpsBanner`, which
  returns `null` when nobody is signed in or no ops backend is registered,
  so it can never break a page. It renders only on the client (pending
  snippet) so it never delays SSR. Attention items link to
  `/ops/conditions#<id>`; the × calls `markOpsVisited` (any signed-in user)
  and hides it for the page view; whether it shows again is the backend's
  `Banner.show`.
- Acknowledge is admin-only and available on the overview and the
  conditions page; it refreshes status, conditions and the banner.

## Consequences
Read-only users see the same information with admin controls disabled and a
tooltip saying why (ADR 0050).
