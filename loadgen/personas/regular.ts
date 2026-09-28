/**
 * `regular/<scenario>-<n>` — an allowlisted regular (ADR 0071): logs in as
 * one of `LOADGEN_ALLOWLISTED`, association NONE. Expected: never closed.
 */
import { regularBody, regularTitle } from '../text';
import { trustedChart, type TrustedData } from './trusted';

export const KIND = 'regular';
export type RegularData = TrustedData;
export const regularChart = () =>
	trustedChart({ kind: KIND, name: 'allowlisted regular', title: regularTitle, body: regularBody, who: 'An allowlisted regular' });
