import {
	type CasePlacementEntry,
	type CasePlacementHome,
	formCasePlacementView,
} from "@/lib/doc/casePlacements";
import type { BlueprintDoc, Uuid } from "@/lib/domain";

/** Where CommCare HQ keeps a case change, in the words a read gives it. */
export type CasePlacementWords = "case management" | "save to case";

function placementWords(home: CasePlacementHome): CasePlacementWords {
	return home === "save-to-case" ? "save to case" : "case management";
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
		operations[operationUuid] = placementWords(entry.home);
	return {
		operations,
		...(view.ownClose !== undefined && {
			ownClose: placementWords(view.ownClose.home),
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
		placement: placementWords(entry.home),
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
