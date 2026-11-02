/**
 * Identity moves in private work. Each staged edit is planned over the
 * private candidate by `lib/doc/identityMoves.ts::withIdentityMoves`, which
 * appends the one `holdPlacements` the edit's stranded holds need. Private
 * work also answers to the saved document it began from: `saveWork` commits
 * every step as one batch, and the commit kernel admits a hold change over
 * that batch only where the saved hold can no longer express its target (or
 * the change restores what a recording wrote). So where a later step puts the
 * content back and the saved hold can express its target again, the step
 * also puts the saved hold back. Until the work is saved, no move has reached
 * CommCare HQ, so taking one back moves nothing.
 *
 * The saved document's holds stand in as the recorded holds when moves are
 * stated: a hold change back to the saved hold is a pending move taken back,
 * not a move.
 */

import {
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import {
	documentHoldsIdentity,
	type IdentityMove,
	identityMovesBetween,
	withIdentityMoves,
} from "@/lib/doc/identityMoves";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
} from "@/lib/doc/mutationAdmission";
import {
	holdChangeMoves,
	holdExpresses,
	placementHoldChanges,
	placementHoldEntry,
	placementTargetKey,
	readPlacementHolds,
} from "@/lib/doc/placementHolds";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

export interface StagedIdentityMoves {
	/** The step's batch, with its hold changes appended as one
	 *  `holdPlacements` where it needs any. */
	readonly batch: AdmittedMutationBatch;
	/** Every move the step makes over the private candidate. */
	readonly moves: readonly IdentityMove[];
}

/**
 * The batch a private step stages and the moves it makes: `batch` planned
 * over `candidate` (the private document before the step), with every hold
 * the saved document `base` holds put back where the step's result lets that
 * saved hold express its target again.
 */
export function planStagedIdentityMoves(
	base: BlueprintDoc,
	candidate: BlueprintDoc,
	batch: AdmittedMutationBatch,
): StagedIdentityMoves {
	const recorded = readPlacementHolds(base);
	const plan = withIdentityMoves(candidate, batch, { recorded });
	const planned = admitMutationBatch(plan.batch);
	if (!documentHoldsIdentity(base))
		return { batch: planned, moves: plan.moves };
	const prepared =
		plan.prepared ?? prepareMutationCandidate(candidate, planned);
	if (preparedCandidateHasAdmissionIssue(prepared))
		return { batch: planned, moves: plan.moves };
	let restores = savedHoldsExpressedAgain(base, prepared.nextDoc);
	// Each restore is judged with only its own slot put back; together they
	// are judged again until every one kept expresses its target.
	while (restores.length > 0) {
		const restored = withHoldEntries(planned, restores);
		const next = prepareMutationCandidate(candidate, restored);
		if (preparedCandidateHasAdmissionIssue(next))
			return { batch: planned, moves: plan.moves };
		const kept = restores.filter((entry) => holdExpresses(next.nextDoc, entry));
		if (kept.length === restores.length)
			return {
				batch: restored,
				moves: identityMovesBetween(candidate, next.nextDoc, { recorded }),
			};
		restores = kept;
	}
	return { batch: planned, moves: plan.moves };
}

/** The saved hold of every target whose hold `after` changes from `base`
 *  while the saved hold can still express it. */
function savedHoldsExpressedAgain(
	base: BlueprintDoc,
	after: BlueprintDoc,
): PlacementHoldEntry[] {
	return placementHoldChanges(base, after)
		.filter((change) => change.from !== null && !holdChangeMoves(after, change))
		.map((change) => placementHoldEntry(change.target, change.from));
}

/** `batch` with `entries` in its one `holdPlacements`, each replacing the
 *  batch's own entry for the same target. */
function withHoldEntries(
	batch: AdmittedMutationBatch,
	entries: readonly PlacementHoldEntry[],
): AdmittedMutationBatch {
	const keys = new Set(entries.map(placementTargetKey));
	const kept: PlacementHoldEntry[] = [];
	const content: Mutation[] = [];
	for (const mutation of batch) {
		if (mutation.kind !== "holdPlacements") {
			content.push(mutation);
			continue;
		}
		for (const hold of mutation.holds)
			if (!keys.has(placementTargetKey(hold))) kept.push(hold);
	}
	// Cloned before admission: admitted values carry internal markers a
	// fresh admission refuses.
	return admitMutationBatch(
		structuredClone([
			...content,
			{ kind: "holdPlacements", holds: [...kept, ...entries] },
		]),
	);
}
