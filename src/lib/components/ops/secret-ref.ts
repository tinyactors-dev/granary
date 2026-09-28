/**
 * Placeholder secret reference the /ops forms put into a draft when the admin
 * typed a new secret value instead of picking a stored one (ADR 0141).
 * `ops.remote.ts` stores the value first and substitutes the real reference
 * (save), or passes it as a candidate value (test connection). The value
 * itself never lands in a draft. Duplicated in `src/lib/remote/ops.remote.ts`
 * (keep in sync).
 */
export const NEW_SECRET_REF = 'new-secret';
