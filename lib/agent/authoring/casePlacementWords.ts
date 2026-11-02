import {
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
