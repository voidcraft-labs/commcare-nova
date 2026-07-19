// components/builder/case-list-config/workspaceProjection.ts
//
// Pure column projections for the case-list authoring workspace. Column
// definitions are shared, while Results and Details each own membership and a
// presentation order. Legacy documents fall back to the original `order` key.

import { resolvedColumnSurfaceOrder } from "@/lib/doc/order/columnSurface";
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
 * Hide one definition from a user-facing screen. The definition always stays
 * in the document so the author can restore it through Add information. Nova
 * treats visibility as a reversible presentation choice, never as deletion.
 */
export function removeColumnFromDisplay(
	columns: readonly Column[],
	uuid: Column["uuid"],
	surface: CaseDisplaySurface,
): Column[] {
	return columns.map((column) => {
		if (column.uuid !== uuid) return column;
		return surface === "list"
			? ({
					...column,
					/* Snapshot the resolved fallback before hiding. A later restore
					 * can then return this field to the exact place the author arranged
					 * instead of quietly appending it to the end. */
					listOrder: resolvedColumnSurfaceOrder(column, surface),
					visibleInList: false,
				} as Column)
			: ({
					...column,
					detailOrder: resolvedColumnSurfaceOrder(column, surface),
					visibleInDetail: false,
				} as Column);
	});
}

/**
 * Restore a definition to one screen. A field hidden through Nova carries a
 * surface-order snapshot and returns to that place; a definition that has
 * never appeared on the screen has no surface key and joins at the end.
 */
export function showColumnOnDisplay(
	columns: readonly Column[],
	uuid: Column["uuid"],
	surface: CaseDisplaySurface,
	appendOrder: string,
): Column[] {
	return columns.map((column) => {
		if (column.uuid !== uuid) return column;
		if (surface === "list") {
			const { visibleInList: _visibility, ...rest } = column;
			return {
				...rest,
				listOrder: column.listOrder ?? appendOrder,
			} as Column;
		}
		const { visibleInDetail: _visibility, ...rest } = column;
		return {
			...rest,
			detailOrder: column.detailOrder ?? appendOrder,
		} as Column;
	});
}

/**
 * Retain hidden definitions when their Default order role changes. This helper
 * remains at the historical call seam, but intentionally performs no pruning:
 * visibility is reversible and must not be coupled to sorting.
 */
export function pruneStoppedSortOrphans(
	_previous: readonly Column[],
	next: readonly Column[],
): Column[] {
	return [...next];
}
