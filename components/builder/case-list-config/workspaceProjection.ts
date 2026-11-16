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
 * in that screen's sequence, because hiding never took it out of there. Shown
 * on Results, a definition is on the list too, so both list slots clear in
 * the one write.
 */
export function showColumnOnDisplay(
	columns: readonly Column[],
	uuid: Column["uuid"],
	surface: CaseDisplaySurface,
): Column[] {
	return columns.map((column) => {
		if (column.uuid !== uuid) return column;
		if (surface === "list") {
			const {
				visibleInList: _visibility,
				notOnList: _notOnList,
				...rest
			} = column;
			return rest as Column;
		}
		const { visibleInDetail: _visibility, ...rest } = column;
		return rest as Column;
	});
}

/**
 * Take a definition hidden from Results off the list altogether: the case's
 * detail alone holds it, so the list neither searches nor sorts by it. The
 * field's **List search matches this** switch turned off. A definition shown
 * on Results is left as it is, since one shown is always on the list.
 */
export function takeColumnOffList(
	columns: readonly Column[],
	uuid: Column["uuid"],
): Column[] {
	return columns.map((column) =>
		column.uuid === uuid && column.visibleInList === false
			? ({ ...column, notOnList: true } as Column)
			: column,
	);
}

/**
 * Put a definition hidden from Results back on the list, hidden: the list's
 * search matches it again. The **List search matches this** switch turned
 * on.
 */
export function keepColumnOnList(
	columns: readonly Column[],
	uuid: Column["uuid"],
): Column[] {
	return columns.map((column) => {
		if (column.uuid !== uuid) return column;
		const { notOnList: _notOnList, ...rest } = column;
		return rest as Column;
	});
}

/** The **List search matches this** switch's label and its lines. */
export const LIST_SEARCH_SWITCH_LABEL = "List search matches this";
export const LIST_SEARCH_ON_LINE =
	"People filtering the list can find a case by this, though the list doesn't show it.";
export const LIST_SEARCH_OFF_LINE =
	"Only Details shows this. The list doesn't search or sort by it.";
export const LIST_SEARCH_SORTED_REASON =
	"The list sorts by this, so its search matches it too. You can remove it from Default order to change that.";

/** What the **List search matches this** switch shows for one field. */
export interface ListSearchSwitchState {
	/** On is the field hidden from Results and still on the list. */
	readonly checked: boolean;
	/** The line under the switch, absent while it is disabled. */
	readonly description?: string;
	/** Why the switch can't change, while Default order uses the field. */
	readonly disabledReason?: string;
}

/**
 * The switch a field's inspector shows above Hide, or `undefined` where it
 * shows none: a field shown on Results is always on the list, and in a tile
 * list a hidden field is matched only through its sort row, which the tile's
 * own note says. While Default order uses the field it is on the list, and
 * the switch is on and disabled with its reason.
 */
export function listSearchSwitch(
	column: Column,
	tiled: boolean,
): ListSearchSwitchState | undefined {
	if (column.visibleInList !== false || tiled) return undefined;
	if (column.sort !== undefined) {
		return { checked: true, disabledReason: LIST_SEARCH_SORTED_REASON };
	}
	const on = column.notOnList !== true;
	return {
		checked: on,
		description: on ? LIST_SEARCH_ON_LINE : LIST_SEARCH_OFF_LINE,
	};
}
