/**
 * The move planner for held case changes: where an edit leaves a case
 * operation's or an own close's held placement unable to express it, the
 * placement it takes instead, recorded as held at once, and the move a
 * person is told about.
 *
 * The subject was published at its held place, so moving it changes where
 * its answers sit in every project space the app is published to; the new
 * place is the one Nova keeps from then on. `withIdentityMoves`
 * (`identityMoves.ts`) appends the entries returned here to the edit's batch
 * as one `holdPlacements`, so the commit gate and the commit kernel's
 * placement rule see the move made by the batch that needs it.
 *
 * Removing an operation is no move: its data goes with it, and its hold
 * goes with the operation. The own close is the one subject that can vanish
 * while its hold stays on the form (the form stops closing its case); its
 * hold is cleared, and nothing is stated.
 *
 * One of the allowlisted `lib/doc` consumers of `lib/commcare` in
 * `biome.json`: where a case change is kept is `lib/commcare/placement.ts`'s
 * answer.
 */

import { produce } from "immer";
import {
	type InexpressibleHold,
	type PlacementSubject,
	planPlacements,
} from "@/lib/commcare/placement";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import type { IdentityMove } from "@/lib/doc/identityMoves";
import type { PlacementHoldEntry } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CasePlacement,
	ownRecordValue,
	type Uuid,
} from "@/lib/domain";
import { placementLabel } from "@/lib/domain/placementCopy";

type OperationHoldEntry = Extract<
	PlacementHoldEntry,
	{ target: "case-operation" | "own-close" }
>;

export interface OperationPlacementMoves {
	/** The `holdPlacements` entries the moves need, in document order. */
	readonly holds: readonly OperationHoldEntry[];
	/** Every move those entries make, in the same order. A cleared own close
	 *  whose form no longer closes its case has an entry and no move. */
	readonly moves: readonly IdentityMove[];
}

/** Whether the form holds a case operation's or its own close's placement. */
function formHoldsOperationPlacement(doc: BlueprintDoc, formUuid: Uuid) {
	const form = ownRecordValue(doc.forms, formUuid);
	return (
		form !== undefined &&
		(form.ownClosePlacement !== undefined ||
			(form.caseOperations ?? []).some((op) => op.placement !== undefined))
	);
}

/** `doc` with every hold of `formUuid` in `inexpressible` removed: the
 *  document the moved subjects are placed in, every other hold kept. */
function withoutHolds(
	doc: BlueprintDoc,
	formUuid: Uuid,
	inexpressible: readonly InexpressibleHold[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		const form = ownRecordValue(draft.forms, formUuid);
		if (form === undefined) return;
		for (const { subject } of inexpressible) {
			if (subject.kind === "own-close") {
				delete form.ownClosePlacement;
				continue;
			}
			const operation = form.caseOperations?.find(
				(op) => op.uuid === subject.operationUuid,
			);
			if (operation !== undefined) delete operation.placement;
		}
	});
}

function plannedPlacement(
	doc: BlueprintDoc,
	formUuid: Uuid,
	subject: PlacementSubject,
) {
	const planned = planPlacements(doc, formUuid).placements.get(
		subject.kind === "own-close" ? "own-close" : subject.operationUuid,
	);
	if (planned === undefined && subject.kind === "operation")
		throw new Error(
			`Nova looked for where the case change ${subject.operationUuid} of form ${formUuid} goes once its held place no longer fits it, and the form's placement plan has no place for it. Every case change of a form is given a place, so the plan and the form disagree.`,
		);
	return planned;
}

/**
 * Over `candidate`, the document an edit produces: for every form, each
 * held case operation and own close whose hold no longer expresses it, the
 * `holdPlacements` entry recording where it goes and the move that states
 * it. A form whose holds all still express its changes yields nothing.
 */
export function planOperationPlacementMoves(
	candidate: BlueprintDoc,
): OperationPlacementMoves {
	const holds: OperationHoldEntry[] = [];
	const moves: IdentityMove[] = [];
	for (const moduleUuid of candidate.moduleOrder) {
		for (const formUuid of orderedFormUuids(candidate, moduleUuid)) {
			if (!formHoldsOperationPlacement(candidate, formUuid)) continue;
			const { inexpressible } = planPlacements(candidate, formUuid);
			if (inexpressible.length === 0) continue;
			// Every stranded hold of the form is placed as if unheld, in one
			// plan, so two moved subcases never claim one index.
			const unheld = withoutHolds(candidate, formUuid, inexpressible);
			for (const { subject, held, reasons } of inexpressible) {
				const planned = plannedPlacement(unheld, formUuid, subject);
				if (subject.kind === "own-close") {
					// The form no longer closes its case: the subject left with
					// its close, so the hold is cleared and nothing moves.
					if (planned === undefined || reasons[0].reason === "no-close") {
						holds.push({ target: "own-close", formUuid, placement: null });
						continue;
					}
					// Sharing the own arm's place, the close has no block of its
					// own to hold; the own arm's hold carries the place.
					const to: CasePlacement = planned.placement;
					holds.push({
						target: "own-close",
						formUuid,
						placement:
							planned.sharesWith === undefined && to.kind === "save-to-case"
								? { kind: "save-to-case", path: to.path }
								: null,
					});
					moves.push({
						subject: { kind: "own-close", formUuid },
						from: placementLabel(held),
						to: placementLabel(to),
						reason: { source: "case-placement", reason: reasons[0] },
					});
					continue;
				}
				if (planned === undefined) continue;
				holds.push({
					target: "case-operation",
					formUuid,
					operationUuid: subject.operationUuid,
					placement: planned.placement,
				});
				moves.push({
					subject: {
						kind: "case-operation",
						formUuid,
						operationUuid: subject.operationUuid,
					},
					from: placementLabel(held),
					to: placementLabel(planned.placement),
					reason: { source: "case-placement", reason: reasons[0] },
				});
			}
		}
	}
	return { holds, moves };
}
