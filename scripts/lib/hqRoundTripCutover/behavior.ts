/**
 * The lines for changes that write nothing: what a worker, an export or a
 * person sees differently with no stored change. One exported selection
 * function per document reason, each reading the migrated document, added by
 * the pull request that owns its reason. None of them is a step and none
 * changes the document.
 */

import type { BlueprintDoc } from "@/lib/domain";
import type { DocumentChange } from "./transform";

/** One no-write reason's selection over the migrated document. */
export interface BehaviorSelection {
	readonly reason: DocumentChange["reason"];
	select(target: BlueprintDoc): readonly DocumentChange[];
}

/** Every no-write document reason's selection, in the enum's order. */
export const BEHAVIOR_SELECTIONS: readonly BehaviorSelection[] = [];

/** The no-write document lines for one migrated document. */
export function behaviorChanges(target: BlueprintDoc): DocumentChange[] {
	return BEHAVIOR_SELECTIONS.flatMap((selection) => selection.select(target));
}
