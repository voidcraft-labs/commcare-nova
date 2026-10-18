/** Project the real document gate into workspace marks; local checks only cover presentation structure. */
import type { CaseWorkspaceBoundaryVerdicts } from "@/lib/doc/hooks/useCaseWorkspaceVerdicts";
import type { ProseProjector } from "@/lib/doc/hooks/useProseProjection";
import type { CaseListConfig, CaseType, Column, Uuid } from "@/lib/domain";

import {
	columnCardSchemas,
	resolveColumnProperty,
} from "./columnEditorSchemas";
import { resolveRows, rowHasStructuralError } from "./searchInputResolution";
import { tileIssuesByColumn, tileLayoutIssues } from "./tile/tileModel";

/** Which workspace tabs currently host a configuration error, the
 *  tab strip badges these so a problem on an unopened tab is visible
 *  from anywhere in the workspace. */
export interface CaseListConfigErrorAreas {
	readonly search: boolean;
	readonly list: boolean;
	readonly detail: boolean;
}

export interface CaseListConfigVerdicts {
	readonly errorAreas: CaseListConfigErrorAreas;
	readonly brokenColumns: ReadonlySet<Uuid>;
	/** The Results canvas marks its filter composer directly so a
	 *  problem remains findable even when no result fields are visible. */
	readonly filterBroken: boolean;
	/** Imported Search-action rules need a distinct mark in Search settings. */
	readonly searchButtonConditionBroken: boolean;
	/** Assigned-case expressions live in Results beside Cases available. */
	readonly excludedOwnerIdsBroken: boolean;
	/** Tile-placement problems, keyed by the field they belong to, in
	 *  the words the grid and the inspector show. Empty for a case list
	 *  with no stored cells. */
	readonly tileIssues: ReadonlyMap<Uuid, readonly string[]>;
}

export interface CaseListConfigVerdictOptions {
	readonly caseSearchEnabled?: boolean;
	/** Absolute module-rule findings projected from the live BlueprintDoc. */
	readonly boundary: CaseWorkspaceBoundaryVerdicts;
}

export function caseListConfigVerdicts(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
	project: ProseProjector,
	options: CaseListConfigVerdictOptions,
): CaseListConfigVerdicts {
	const boundary = options.boundary;
	const editCtx = { caseTypes, currentCaseType };

	// ── Columns: one pass feeds the marks and tab dots. ──
	const brokenColumns = new Set<Uuid>();
	let listColumnsBroken = false;
	let detailColumnsBroken = false;
	const markBrokenColumn = (column: Column) => {
		brokenColumns.add(column.uuid);
		if (column.visibleInList !== false || column.sort !== undefined) {
			listColumnsBroken = true;
		}
		if (column.visibleInDetail !== false) detailColumnsBroken = true;
	};
	for (const col of config.columns) {
		if (col.kind === "calculated") continue;
		const applicable = columnCardSchemas[col.kind].applicableForProperty(
			resolveColumnProperty(editCtx, col.field),
		);
		if (!applicable) markBrokenColumn(col);
	}
	for (const uuid of boundary.brokenColumnUuids) {
		const column = config.columns.find((candidate) => candidate.uuid === uuid);
		if (column !== undefined) markBrokenColumn(column);
	}

	// ── Tile placement ──
	// Geometry is checked whether or not the layout is on, so a stored
	// cell that could not come back is visible before the author asks for
	// it; coverage only while it is on. Both mirror the validator rule.
	const tileIssues = tileIssuesByColumn(tileLayoutIssues(config));

	const filterIsBroken = boundary.filterBroken;
	let search =
		boundary.searchInputsBroken || boundary.searchButtonConditionBroken;
	const resolved = resolveRows(
		config.searchInputs,
		caseTypes,
		currentCaseType,
		project,
	);
	for (let i = 0; i < config.searchInputs.length; i++) {
		const row = config.searchInputs[i];
		const rowResolved = resolved[i];
		if (row === undefined || rowResolved === undefined) continue;
		if (rowHasStructuralError(rowResolved)) {
			search = true;
		}
	}

	return {
		errorAreas: {
			search,
			list:
				listColumnsBroken ||
				filterIsBroken ||
				boundary.excludedOwnerIdsBroken ||
				tileIssues.size > 0,
			detail: detailColumnsBroken,
		},
		brokenColumns,
		filterBroken: filterIsBroken,
		searchButtonConditionBroken: boundary.searchButtonConditionBroken,
		excludedOwnerIdsBroken: boundary.excludedOwnerIdsBroken,
		tileIssues,
	};
}
