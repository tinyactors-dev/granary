/**
 * Numeric ids for users, repos, issues and comments (ADR 0060).
 *
 * One monotonic counter per process, seeded from the wall clock in ms, and
 * NOT reset by `/__control/reset`: granary keys issues by the numeric
 * `repository.id`, so a repo re-created after a reset (or after a fake
 * restart against a long-lived app database) must get a fresh id.
 */
let next = Date.now();
export const nextId = (): number => ++next;
