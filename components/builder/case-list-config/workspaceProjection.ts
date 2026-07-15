// components/builder/case-list-config/workspaceProjection.ts
//
// Pure column projections for the case-list authoring workspace. The domain
// stores one globally ordered column sequence; list/detail canvases consume
// different visibility views of that sequence without inventing a second
// order or rendering hidden columns as ordinary content.

import { bySortKey } from "@/lib/doc/order/compare";
import type { Column } from "@/lib/domain";

export interface CaseWorkspaceColumnProjection {
	/** The complete display-order sequence. */
	readonly ordered: readonly Column[];
	readonly listVisible: readonly Column[];
	/** All columns absent from the list, including fully hidden columns. */
	readonly listHidden: readonly Column[];
	readonly detailVisible: readonly Column[];
	/** All columns absent from detail, including fully hidden columns. */
	readonly detailHidden: readonly Column[];
	/** Columns absent from both user-facing surfaces. */
	readonly fullyHidden: readonly Column[];
}

/**
 * Sort columns once by the document's canonical display comparator, then
 * derive every workspace visibility projection from that one sequence.
 * Visibility slots follow the domain convention: absent is visible.
 */
export function projectCaseWorkspaceColumns(
	columns: readonly Column[],
): CaseWorkspaceColumnProjection {
	const ordered = [...columns].sort(bySortKey);
	const listVisible: Column[] = [];
	const listHidden: Column[] = [];
	const detailVisible: Column[] = [];
	const detailHidden: Column[] = [];
	const fullyHidden: Column[] = [];

	for (const column of ordered) {
		const visibleInList = column.visibleInList !== false;
		const visibleInDetail = column.visibleInDetail !== false;

		(visibleInList ? listVisible : listHidden).push(column);
		(visibleInDetail ? detailVisible : detailHidden).push(column);
		if (!visibleInList && !visibleInDetail) fullyHidden.push(column);
	}

	return {
		ordered,
		listVisible,
		listHidden,
		detailVisible,
		detailHidden,
		fullyHidden,
	};
}
