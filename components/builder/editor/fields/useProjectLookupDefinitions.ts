"use client";

// The Project's tables and their columns, for the pickers that bind a select
// to one.
//
// The manifest gives the table LIST; it carries counts and revisions but no
// column definitions. Columns come from a separate read of ONE table — the one
// whose columns are needed right now, which is the bound table while a field is
// bound and the table being CONSIDERED while the author is choosing one.
// Without that second case, choosing a table would find no columns to bind
// with and the choice would silently do nothing.
//
// These are independent hook instances rather than the Project data
// workspace's own reads: a selected select field's editor can be open with no
// Project data URL anywhere in sight, so it cannot depend on that controller
// having fetched anything. The cost is one extra manifest read per selected
// select field.

import { useMemo } from "react";
import {
	useProjectDataManifest,
	useProjectDataTable,
} from "@/components/builder/project-data/useProjectData";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupColumn } from "@/lib/lookup/types";

export interface LookupTableChoice {
	readonly id: LookupTableId;
	readonly name: string;
	readonly columns: readonly LookupColumn[];
}

export interface ProjectLookupDefinitions {
	/** Every table in the Project, for the "where do the choices come from"
	 *  picker. Columns are populated only for the focused table. */
	readonly definitions: readonly LookupTableChoice[];
	readonly byId: ReadonlyMap<LookupTableId, LookupTableChoice>;
	/** True while the focused table's columns are still loading, so a picker can
	 *  wait rather than treat "no columns yet" as "no columns". */
	readonly loadingFocused: boolean;
	/** True while the table LIST is still loading. Without it, a bound table
	 *  absent from an unloaded manifest reads as "deleted", which is a false
	 *  alarm on every first paint. */
	readonly loadingList: boolean;
}

/**
 * @param focusedTableId the table whose columns are needed right now — the one
 * a field is bound to, or the one the author has just chosen and is about to be
 * bound to.
 */
export function useProjectLookupDefinitions(
	focusedTableId?: LookupTableId,
): ProjectLookupDefinitions {
	const manifest = useProjectDataManifest();
	const focused = useProjectDataTable(focusedTableId);

	return useMemo(() => {
		const focusedSnapshot =
			focused.state.kind === "data" ? focused.state.value : undefined;
		const definitions: LookupTableChoice[] =
			manifest.state.kind === "data"
				? manifest.state.value.tables.map((entry) => ({
						id: entry.id,
						name: entry.name,
						columns:
							focusedSnapshot !== undefined && focusedSnapshot.id === entry.id
								? focusedSnapshot.columns
								: [],
					}))
				: [];
		return {
			definitions,
			byId: new Map(definitions.map((entry) => [entry.id, entry])),
			loadingFocused:
				focusedTableId !== undefined &&
				(focused.state.kind === "loading" || focused.state.kind === "idle"),
			loadingList:
				manifest.state.kind === "loading" || manifest.state.kind === "idle",
		};
	}, [manifest.state, focused.state, focusedTableId]);
}
