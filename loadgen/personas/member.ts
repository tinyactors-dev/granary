/**
 * `member/<scenario>-<n>` — an org member (ADR 0071): association MEMBER,
 * fresh login. Expected: never closed.
 */
import { trustedChart, type TrustedData } from './trusted';

export const KIND = 'member';
export type MemberData = TrustedData;
export const memberChart = trustedChart({ kind: KIND, texts: 'regular', who: 'An org member' });
