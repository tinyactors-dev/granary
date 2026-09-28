/** Budgets and disk thresholds (ADR 0098, 0107, 0108). Relative to what the VM reports at runtime. */
import { Type, type Static } from '@sinclair/typebox';
import { GiB } from './common';

export const Budgets = Type.Object(
	{
		/** Billed exe.dev egress: R2 uploads only. */
		r2EgressBytesPerMonth: Type.Integer({ minimum: GiB, maximum: 2048 * GiB, default: 20 * GiB }),
		disk: Type.Object(
			{
				/** A backup starts only if free − dbSize ≥ max(minFreeBytes, minFreeRatio × total). */
				minFreeBytes: Type.Integer({ minimum: 0, default: GiB }),
				minFreeRatio: Type.Number({ minimum: 0, maximum: 0.5, default: 0.1 }),
				/** Attention after its grace period when free < ratio × total or < 2 × DB size. */
				attentionFreeRatio: Type.Number({ minimum: 0, maximum: 0.9, default: 0.2 }),
				/** The single local copy is kept only while free after it ≥ ratio × total. */
				localCopyMinFreeRatio: Type.Number({ minimum: 0, maximum: 0.9, default: 0.3 })
			},
			{ additionalProperties: false }
		),
		memory: Type.Object(
			{ attentionRssRatio: Type.Number({ minimum: 0.1, maximum: 0.95, default: 0.6 }) },
			{ additionalProperties: false }
		),
		version: Type.Integer({ minimum: 1 })
	},
	{ additionalProperties: false }
);
export type Budgets = Static<typeof Budgets>;

export const DEFAULT_BUDGETS: Budgets = {
	r2EgressBytesPerMonth: 20 * GiB,
	disk: { minFreeBytes: GiB, minFreeRatio: 0.1, attentionFreeRatio: 0.2, localCopyMinFreeRatio: 0.3 },
	memory: { attentionRssRatio: 0.6 },
	version: 1
};
