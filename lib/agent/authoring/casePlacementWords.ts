import {
	type CasePlacementEntry,
	formCasePlacementView,
} from "@/lib/doc/casePlacements";
import type { BlueprintDoc, CasePlacement, Uuid } from "@/lib/domain";

/** Where CommCare HQ keeps a case change, in the words a read gives it: a
 *  basic form's Case Management, an advanced form's case actions, or a Save
 *  to Case block. */
export type CasePlacementWords =
	| "case management"
	| "case actions"
	| "save to case";

function placementWords(placement: CasePlacement): CasePlacementWords {
	switch (placement.kind) {
		case "basic":
			return "case management";
		case "advanced":
			return "case actions";
		case "save-to-case":
			return "save to case";
		default: {
			const _exhaustive: never = placement;
			return _exhaustive;
		}
	}
}

/** Where CommCare HQ keeps each of a form's case changes, by operation
 *  uuid, and its own close when that has a block of its own
 *  (`formCasePlacementView`, which the export reads too). */
export function formCasePlacementWords(
	doc: BlueprintDoc,
	formUuid: Uuid,
): {
	readonly operations: Readonly<Record<Uuid, CasePlacementWords>>;
	readonly ownClose?: CasePlacementWords;
} {
	const view = formCasePlacementView(doc, formUuid);
	const operations: Record<Uuid, CasePlacementWords> = {};
	for (const { operationUuid, entry } of view.operations)
		operations[operationUuid] = placementWords(entry.placement);
	return {
		operations,
		...(view.ownClose !== undefined && {
			ownClose: placementWords(view.ownClose.placement),
		}),
	};
}

/** Where CommCare HQ keeps one case change, as a read gives it, and whether
 *  that is the place a published app recorded and keeps. */
export interface CasePlacementRead {
	readonly placement: CasePlacementWords;
	readonly placementKept?: true;
}

function placementRead(entry: CasePlacementEntry): CasePlacementRead {
	return {
		placement: placementWords(entry.placement),
		...(entry.held && { placementKept: true as const }),
	};
}

/** `formCasePlacementWords` with each place marked where a published app
 *  keeps it: the read `getCaseOperations` gives. */
export function formCasePlacementReads(
	doc: BlueprintDoc,
	formUuid: Uuid,
): {
	readonly operations: Readonly<Record<Uuid, CasePlacementRead>>;
	readonly ownClose?: CasePlacementRead;
} {
	const view = formCasePlacementView(doc, formUuid);
	const operations: Record<Uuid, CasePlacementRead> = {};
	for (const { operationUuid, entry } of view.operations)
		operations[operationUuid] = placementRead(entry);
	return {
		operations,
		...(view.ownClose !== undefined && {
			ownClose: placementRead(view.ownClose),
		}),
	};
}
