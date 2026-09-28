# 74. Fuzzing and chaos personas

Date: 2026-09-28 · Status: accepted

## Decision
**Fuzzer** (`loadgen/personas/fuzzer.ts`): shuffles (by seed) a case list
from `loadgen/fuzz-cases.ts` and executes 8–12 per persona:
- *issue cases* through the normal create path, judged by the oracle:
  256-char titles with emoji/ZWJ/combining marks/RTL, 65 536-char bodies,
  empty bodies, a forged `<!-- granary:… -->` marker in the body, a
  39-character hyphenated login, the allowlisted login in UPPERCASE (must
  stay open), unusual associations (MANNEQUIN, FIRST_TIMER, CONTRIBUTOR),
  OWNER from a stranger (must stay open);
- *race cases*: open then reopen immediately twice;
- *raw cases* via `POST /__control/deliveries/raw` (signed, arbitrary
  body — ADR 75): `issues` missing `issue.user`, `repository.id` as a
  string, a JSON array body, an unknown action, `ping`, a 1 MB unknown
  event, 400-level nesting. Granary must answer < 500 (400/202/401 are
  fine); judged by `webhooks-healthy`.
Titles must be non-empty (GitHub rejects empty titles), so "empty title" is
not a case.

**Chaos monkey** (`loadgen/personas/chaos-monkey.ts`): every few seconds
picks one strike: 500 on the scenario repo's comment POST (1–2 times), 503
on its issue PATCH (1–2), 403 + `Retry-After: 1–2` on comments, a duplicate
delivery (redeliver a recent delivery), or a burst (same delivery 3×).
Fault counts stay ≤ 2 per strike so granary's relay (6 attempts) always
recovers; a fault is scoped by `pathPattern` to the scenario's repository.
Any strike marks the scenario "faults were active", extending
`eventually-closed` by `faultGraceMs`.
