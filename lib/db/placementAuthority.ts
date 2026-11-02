/**
 * Who may change a held placement, decided over the two documents and the
 * recordings rather than over the mutations: a forged autosave, a stale undo
 * inverse and an identity move all meet it alike.
 *
 * A held placement is where CommCare HQ last received a case change (or an
 * own close, or a query repeat's rows), and a recording is what writes one: a
 * `blueprint-migration` row or the fold baseline a cutover wrote. Under an
 * editor's kind a hold may change only two ways, decided per target by
 * `lib/doc/placementHolds.ts`, the same per-change decision the builder's
 * history reads through `admittedHoldChanges`, so the tab and the kernel
 * cannot disagree:
 *
 *   (a) a move: the earlier hold can no longer express its target once the
 *       rest of the batch has landed;
 *   (b) a restore: the later hold is exactly what the target's latest
 *       recording wrote.
 *
 * Pure: the recordings a decision needs are read by
 * `placementRecords.ts::readRecordedPlacementHolds` over the keys
 * `placementChangesToJustify` names, and handed in.
 */

import {
	holdChangeAdmitted,
	holdChangeMoves,
	placementHoldChanges,
	type RecordedPlacementHolds,
} from "@/lib/doc/placementHolds";
import type { BlueprintDoc } from "@/lib/domain";
import type { BlueprintMutationAppChangeKind } from "./types";

export const PLACEMENT_CHANGE_REFUSAL =
	"Nova keeps each case change where CommCare HQ last received it, and only a publish records a new place. This change would move one that can stay where it is, so nothing was saved. Reload the app and make the change again.";

/**
 * The app change kinds that record placements. A row of one of these kinds
 * may change any hold, and its `holdPlacements` entries are the recordings an
 * editor's restore is held to.
 */
export const PLACEMENT_RECORDING_KINDS = [
	"blueprint-migration",
] as const satisfies readonly BlueprintMutationAppChangeKind[];

const RECORDING_KIND_SET: ReadonlySet<string> = new Set(
	PLACEMENT_RECORDING_KINDS,
);

/** Whether `kind` is a recording kind, which may change any hold (rule 1). */
export function recordsPlacements(
	kind: BlueprintMutationAppChangeKind,
): boolean {
	return RECORDING_KIND_SET.has(kind);
}

/**
 * The target keys whose change only a recording can admit: every hold change
 * that is not a move, under an editor's kind. A recording kind, a target
 * removed with its owner, an unchanged hold and a move leave nothing to
 * justify. The kernel reads the recorded holds for these keys alone, so an
 * edit that changes no hold, and every move, reads nothing.
 */
export function placementChangesToJustify(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	kind: BlueprintMutationAppChangeKind,
): readonly string[] {
	if (recordsPlacements(kind)) return [];
	return placementHoldChanges(prev, next)
		.filter((change) => !holdChangeMoves(next, change))
		.map((change) => change.key);
}

/**
 * The refusal for a batch that takes `prev` to `next` under `kind`, or `null`
 * where every hold it changes is a move or a restore of the recorded hold.
 * Refused: a hold an editor gains that no recording wrote, the replacement or
 * clearing of a hold that can still express its target, and the restore of a
 * hold the latest recording did not write. One refusal covers any number of
 * targets.
 */
export function placementChangeRefusal(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	kind: BlueprintMutationAppChangeKind,
	recorded: RecordedPlacementHolds,
): string | null {
	if (recordsPlacements(kind)) return null;
	const refused = placementHoldChanges(prev, next).some(
		(change) => !holdChangeAdmitted(next, change, recorded),
	);
	return refused ? PLACEMENT_CHANGE_REFUSAL : null;
}
