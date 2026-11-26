// components/builder/case-list-config/canvas/detailTabDraft.ts
//
// The Edit tabs dialog's draft transitions. Pure, so each one is a
// function of the draft alone. A field's "Use only for ordering" checkbox
// shows only on its own tab while that tab lists records, so a transition
// that takes the field away from the tab, or the records away from it,
// clears that choice too: the author could not clear it in place.

import type { DetailTabGroup } from "@/lib/doc/caseDetailTabMutations";
import type { Uuid } from "@/lib/domain";

/** Move `field` to the end of `destination`'s fields. */
export function moveDraftField(
	draft: readonly DetailTabGroup[],
	field: Uuid,
	destination: Uuid,
): DetailTabGroup[] {
	return draft.map((group) =>
		group.uuid === destination
			? { ...group, fields: [...group.fields, field] }
			: {
					...group,
					fields: group.fields.filter((one) => one !== field),
					...(group.orderFields && {
						orderFields: group.orderFields.filter((one) => one !== field),
					}),
				},
	);
}

/** Set which records a tab lists; `null` shows the selected case alone. */
export function setDraftRowSource(
	draft: readonly DetailTabGroup[],
	tab: Uuid,
	rowSource: DetailTabGroup["rowSource"],
): DetailTabGroup[] {
	return draft.map((group) =>
		group.uuid !== tab
			? group
			: {
					...group,
					rowSource,
					...(rowSource === null && { orderFields: [] }),
				},
	);
}
