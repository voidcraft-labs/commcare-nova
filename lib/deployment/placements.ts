import "server-only";

import { commitGuardedBatch } from "@/lib/db/apps";
import {
	AppHeadMovedError,
	BlueprintCommitRejectedError,
} from "@/lib/db/commitGuard";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { PlacementHoldEntry } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import type { DeploymentScope } from "./store";

/**
 * What recording a publish's placements came to: the change written and the
 * document it left, a head that moved since the publish emitted (nothing
 * written), or the kernel's refusal (nothing written).
 */
export type RecordPlacementsOutcome =
	| {
			readonly kind: "recorded";
			readonly seq: number;
			readonly doc: BlueprintDoc;
			readonly count: number;
	  }
	| { readonly kind: "head-moved" }
	| { readonly kind: "refused"; readonly message: string };

/**
 * Record `holds` as one `publish-placement` change, only while the app's head
 * is `expectedHeadSeq`. The only writer of the kind.
 *
 * Each entry holds a placement, or clears one where an accepted move takes
 * an own close into Case Management, which holds no slot of its own. The
 * kernel admits any hold change under this kind, and still runs the whole
 * gate, so a document this leaves is as valid as the one it read.
 */
export async function recordPublishPlacements(input: {
	readonly scope: DeploymentScope;
	readonly expectedHeadSeq: number;
	readonly holds: readonly PlacementHoldEntry[];
}): Promise<RecordPlacementsOutcome> {
	if (input.holds.length === 0) {
		throw new Error(
			"A publish asked to record its placements with none to record. A change that holds nothing is never written, so the caller has to skip the record instead.",
		);
	}
	try {
		const receipt = await commitGuardedBatch({
			appId: input.scope.appId,
			batchId: crypto.randomUUID(),
			// Cloned before admission: holds read out of an admitted batch carry
			// the markers a fresh admission refuses as not canonical.
			mutations: admitMutationBatch(
				structuredClone([{ kind: "holdPlacements", holds: input.holds }]),
			),
			actorUserId: input.scope.actorUserId,
			kind: "publish-placement",
			expectedProjectId: input.scope.projectId,
			expectedHeadSeq: input.expectedHeadSeq,
		});
		return {
			kind: "recorded",
			seq: receipt.seq,
			doc: receipt.committedDoc,
			count: input.holds.length,
		};
	} catch (error) {
		if (error instanceof AppHeadMovedError) return { kind: "head-moved" };
		if (error instanceof BlueprintCommitRejectedError) {
			/* The holds are the emitter's own derivation over a document the gate
			 * admitted, so a finding here means the two disagree. */
			if (error.findingCodes.length > 0) {
				log.error(
					"[publish] the placements a publish derived failed the gate",
					error,
					{
						appId: input.scope.appId,
						expectedHeadSeq: input.expectedHeadSeq,
						findingCodes: error.findingCodes,
						holds: input.holds.length,
					},
				);
			}
			return { kind: "refused", message: error.message };
		}
		throw error;
	}
}
