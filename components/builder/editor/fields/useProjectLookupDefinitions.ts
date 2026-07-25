"use client";

// The Project's tables and their columns, for the pickers that bind a select
// to one.
//
// Reuses the workspace's own manifest read for the table list, and fetches
// only the OPEN table's columns separately — the manifest carries counts and
// revisions but no column definitions, and a select editor needs the columns
// of exactly one table: the one it is bound to.

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
	 *  picker. Columns are populated only for `boundTableId`. */
	readonly definitions: readonly LookupTableChoice[];
	readonly byId: ReadonlyMap<LookupTableId, LookupTableChoice>;
}

/**
 * @param boundTableId the table this field is currently bound to, whose
 * columns the value/label pickers need. Absent while the field uses its
 * typed-in options.
 */
export function useProjectLookupDefinitions(
	boundTableId?: LookupTableId,
): ProjectLookupDefinitions {
	const manifest = useProjectDataManifest();
	const bound = useProjectDataTable(boundTableId);

	return useMemo(() => {
		const boundSnapshot =
			bound.state.kind === "data" ? bound.state.value : undefined;
		const definitions: LookupTableChoice[] =
			manifest.state.kind === "data"
				? manifest.state.value.tables.map((entry) => ({
						id: entry.id,
						name: entry.name,
						columns:
							boundSnapshot !== undefined && boundSnapshot.id === entry.id
								? boundSnapshot.columns
								: [],
					}))
				: [];
		return {
			definitions,
			byId: new Map(definitions.map((entry) => [entry.id, entry])),
		};
	}, [manifest.state, bound.state]);
}
