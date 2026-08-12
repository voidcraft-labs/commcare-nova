/** Pure admission for the immutable receipt set behind build completion. */

import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import {
	type BuildSlice,
	isExecutableConstructionGroup,
} from "@/lib/agent/design/buildPlan";

/** A deterministic proof failure. Infrastructure errors deliberately retain
 * their original type so the route's shared classifier can redrive them. */
export class BuildCompletionVerificationError extends Error {
	readonly name = "BuildCompletionVerificationError";
}

export function refuseBuildCompletion(message: string): never {
	throw new BuildCompletionVerificationError(message);
}

export interface FrozenBuildLineage {
	readonly designSessionId: string;
	readonly designRevisionId: string;
	readonly designRevisionDigest: string;
	readonly buildPlanId: string;
	readonly buildPlanDigest: string;
	readonly appId: string;
}

/**
 * Require one nonempty committed receipt for every planned workflow, in its
 * exact execution order and under the frozen accepted lineage. The database
 * attempt and canonical-app checks deliberately happen after this pure gate.
 */
export function assertExactCommittedSliceReceipts(args: {
	readonly expectedSlices: readonly BuildSlice[];
	readonly receipts: readonly CommittedSliceReceipt[];
	readonly lineage: FrozenBuildLineage;
}): void {
	if (args.receipts.length !== args.expectedSlices.length) {
		refuseBuildCompletion(
			`Build completion refused: ${args.receipts.length} of ${args.expectedSlices.length} planned workflow slices have committed receipts.`,
		);
	}

	let priorSeq = -1;
	for (const [index, slice] of args.expectedSlices.entries()) {
		const receipt = args.receipts[index];
		if (
			receipt === undefined ||
			receipt.sliceId !== slice.id ||
			receipt.designSessionId !== args.lineage.designSessionId ||
			receipt.designRevisionId !== args.lineage.designRevisionId ||
			receipt.designRevisionDigest !== args.lineage.designRevisionDigest ||
			receipt.buildPlanId !== args.lineage.buildPlanId ||
			receipt.buildPlanDigest !== args.lineage.buildPlanDigest ||
			receipt.appId !== args.lineage.appId ||
			receipt.mutationCount < 1 ||
			receipt.seq <= priorSeq
		) {
			refuseBuildCompletion(
				"Build completion refused: the committed slice set does not exactly match the frozen accepted plan lineage and order.",
			);
		}
		priorSeq = receipt.seq;

		const expectedGroups = new Set(
			slice.constructionGroups
				.filter(isExecutableConstructionGroup)
				.map((group) => group.id as string),
		);
		const covered = new Set(receipt.owningIntentIds as readonly string[]);
		if (
			receipt.owningIntentIds.length !== expectedGroups.size ||
			covered.size !== expectedGroups.size ||
			[...expectedGroups].some((id) => !covered.has(id))
		) {
			refuseBuildCompletion(
				`Build completion refused: slice ${slice.id} lacks exact durable construction-group coverage.`,
			);
		}
	}
}
