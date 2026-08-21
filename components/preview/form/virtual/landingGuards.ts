// components/preview/form/virtual/landingGuards.ts
//
// The two guards every drag landing passes, shared by `useRowDnd`'s
// `canDrop` (may this row accept the dragged field at all? — a header
// row asks for each of its landings and accepts when EITHER holds) and
// `useDragIntent` (may the placeholder open on THIS resolved edge?):
// no cycle — the source is not the landing container or one of its
// ancestors — and a placement the commit gate accepts on a sectioned
// form (`fieldPlacementVerdict`, the same verdict the rail, the
// keyboard, and the SA tools ask). Read against the live document so
// both callers judge the same state.

import { fieldPlacementVerdict } from "@/lib/doc/formSectionVerdicts";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { isUuidInSubtree } from "./dragData";

/** Whether the gate would let `dragUuid` land inside `toParentUuid`. */
export function landingAllowed(
	doc: BlueprintDoc,
	dragUuid: string,
	toParentUuid: Uuid,
): boolean {
	if (
		isUuidInSubtree(
			doc.fieldOrder as Record<string, readonly string[]>,
			dragUuid,
			toParentUuid,
		)
	) {
		return false;
	}
	const dragged = doc.fields[asUuid(dragUuid)];
	if (dragged === undefined) return true;
	return fieldPlacementVerdict(doc, {
		uuid: dragged.uuid,
		kind: dragged.kind,
		toParentUuid,
	}).ok;
}
