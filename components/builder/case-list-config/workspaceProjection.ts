// components/builder/case-list-config/workspaceProjection.ts
//
// Pure column projections for the case-list authoring workspace. Column
// definitions are shared; Results and Details each own a sequence over them.
//
// Both sequences name EVERY column, visible or not, which is what makes hiding
// a genuinely reversible presentation choice: the place is held by the config's
// ordering array, so a restored field returns exactly where the author had it.
// Hiding writes only the visibility slot, so there is no way for a hidden
// column to lose its place.

import { type CaseListConfig, type Column, orderedColumns } from "@/lib/domain";

export type CaseDisplaySurface = "list" | "detail";

export interface CaseWorkspaceColumnProjection {
	/** Every definition, in the Results sequence: the add-menu's recovery list. */
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
 * Split each surface's sequence into what it shows and what it offers.
 * Visibility slots follow the domain convention: absent is visible.
 */
export function projectCaseWorkspaceColumns(
	config: CaseListConfig,
): CaseWorkspaceColumnProjection {
	const listSequence = orderedColumns(config, "list");
	const detailSequence = orderedColumns(config, "detail");

	const listVisible: Column[] = [];
	const listHidden: Column[] = [];
	for (const column of listSequence) {
		(column.visibleInList !== false ? listVisible : listHidden).push(column);
	}

	const detailVisible: Column[] = [];
	const detailHidden: Column[] = [];
	for (const column of detailSequence) {
		(column.visibleInDetail !== false ? detailVisible : detailHidden).push(
			column,
		);
	}

	const fullyHidden = listSequence.filter(
		(column) =>
			column.visibleInList === false && column.visibleInDetail === false,
	);

	return {
		ordered: listSequence,
		listVisible,
		listHidden,
		detailVisible,
		detailHidden,
		fullyHidden,
	};
}

/**
 * Hide one definition from a user-facing screen. The definition always stays in
 * the document, and keeps its place in that screen's sequence, so the author
 * can restore it through Add information. Nova treats visibility as a
 * reversible presentation choice, never as deletion.
 */
export function removeColumnFromDisplay(
	columns: readonly Column[],
	uuid: Column["uuid"],
	surface: CaseDisplaySurface,
): Column[] {
	return columns.map((column) =>
		column.uuid === uuid
			? ({
					...column,
					...(surface === "list"
						? { visibleInList: false }
						: { visibleInDetail: false }),
				} as Column)
			: column,
	);
}

/**
 * Restore a definition to one screen. It returns to the place it already holds
 * in that screen's sequence, because hiding never took it out of there.
 */
export function showColumnOnDisplay(
	columns: readonly Column[],
	uuid: Column["uuid"],
	surface: CaseDisplaySurface,
): Column[] {
	return columns.map((column) => {
		if (column.uuid !== uuid) return column;
		if (surface === "list") {
			const { visibleInList: _visibility, ...rest } = column;
			return rest as Column;
		}
		const { visibleInDetail: _visibility, ...rest } = column;
		return rest as Column;
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
