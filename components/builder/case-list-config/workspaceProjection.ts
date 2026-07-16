// components/builder/case-list-config/workspaceProjection.ts
//
// Pure column projections for the case-list authoring workspace. Column
// definitions are shared, while Results and Details each own membership and a
// presentation order. Legacy documents fall back to the original `order` key.

import {
	byDetailColumnOrder,
	byListColumnOrder,
	bySortKey,
} from "@/lib/doc/order/compare";
import type { Column } from "@/lib/domain";

export type CaseDisplaySurface = "list" | "detail";

export interface CaseWorkspaceColumnProjection {
	/** Membership-wide legacy sequence used to keep add-menu recovery calm. */
	readonly ordered: readonly Column[];
	readonly listVisible: readonly Column[];
	/** Definitions available to add to Results. */
	readonly listHidden: readonly Column[];
	readonly detailVisible: readonly Column[];
	/** Definitions available to add to Details. */
	readonly detailHidden: readonly Column[];
	/** Definitions currently absent from both user-facing screens. */
	readonly fullyHidden: readonly Column[];
}

/**
 * Derive the membership-wide recovery choices used only by Add information,
 * then sort the two visible compositions independently. Visibility slots
 * follow the domain convention: absent is visible.
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
	listVisible.sort(byListColumnOrder);
	detailVisible.sort(byDetailColumnOrder);

	return {
		ordered,
		listVisible,
		listHidden,
		detailVisible,
		detailHidden,
		fullyHidden,
	};
}

/**
 * Remove one definition from a user-facing screen without manufacturing a
 * hidden-field inventory. If this was its final screen and no Default order
 * rule still needs the definition, it leaves the document entirely.
 */
export function removeColumnFromDisplay(
	columns: readonly Column[],
	uuid: Column["uuid"],
	surface: CaseDisplaySurface,
): Column[] {
	const target = columns.find((column) => column.uuid === uuid);
	if (target === undefined) return [...columns];
	const shownOnOtherSurface =
		surface === "list"
			? target.visibleInDetail !== false
			: target.visibleInList !== false;
	if (!shownOnOtherSurface && target.sort === undefined) {
		return columns.filter((column) => column.uuid !== uuid);
	}
	return columns.map((column) => {
		if (column.uuid !== uuid) return column;
		return surface === "list"
			? ({ ...column, visibleInList: false } as Column)
			: ({ ...column, visibleInDetail: false } as Column);
	});
}

/**
 * When an author removes the ordering rule that was an off-screen field's last
 * job, remove that newly-created orphan. Untouched legacy search-only fields
 * are preserved; this cleanup responds only to the sort removal in `next`.
 */
export function pruneStoppedSortOrphans(
	previous: readonly Column[],
	next: readonly Column[],
): Column[] {
	const previousByUuid = new Map(
		previous.map((column) => [column.uuid, column]),
	);
	return next.filter((column) => {
		const before = previousByUuid.get(column.uuid);
		const justStoppedSorting =
			before?.sort !== undefined && column.sort === undefined;
		const shownSomewhere =
			column.visibleInList !== false || column.visibleInDetail !== false;
		return !justStoppedSorting || shownSomewhere;
	});
}
