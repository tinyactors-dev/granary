/**
 * `maintainer/<scenario>-<n>` — a maintainer (ADR 0071): association OWNER
 * or COLLABORATOR, fresh login (not on the allowlist). Expected: never closed.
 */
import { trustedChart, type TrustedData } from './trusted';

export const KIND = 'maintainer';
export type MaintainerData = TrustedData;
export const maintainerChart = trustedChart({ kind: KIND, texts: 'maintainer', who: 'A maintainer' });
