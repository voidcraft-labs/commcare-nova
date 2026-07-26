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
	useProjectDataDefinition,
	useProjectDataManifest,
} from "@/components/builder/project-data/useProjectData";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupColumn } from "@/lib/lookup/types";
import { useProjectId } from "@/lib/session/hooks";
import { projectLookupDefinitionContext } from "./projectLookupDefinitionContext";

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
	/** Exact focused definition snapshot for the optimistic client commit gate.
	 * The server repeats the verdict against fresh Project state. */
	readonly lookupContext: LookupValidationContext;
	readonly listFailure: string | null;
	readonly focusedFailure: string | null;
	readonly retryList: () => Promise<void>;
	readonly retryFocused: () => Promise<void>;
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
	const focused = useProjectDataDefinition(focusedTableId);
	const currentProjectId = useProjectId();

	return useMemo(() => {
		const manifestEntry =
			manifest.state.kind === "data"
				? manifest.state.value.tables.find(
						(entry) => entry.id === focusedTableId,
					)
				: undefined;
		/* `useReloadableResource` deliberately keeps stale data while a new table
		 * loads. Never hand the prior table's definition to a gesture targeting
		 * the next one. */
		const loadedSnapshot =
			focused.state.kind === "data" ? focused.state.value : undefined;
		const lookupContext = projectLookupDefinitionContext({
			currentProjectId,
			manifestProjectId:
				manifest.state.kind === "data"
					? manifest.state.value.projectId
					: undefined,
			focusedTableId,
			manifestEntry,
			snapshot: loadedSnapshot,
		});
		const focusedDefinition =
			lookupContext.kind === "available"
				? loadedSnapshot?.definitions.find(
						(definition) => definition.id === focusedTableId,
					)
				: undefined;
		const definitions: LookupTableChoice[] =
			manifest.state.kind === "data"
				? manifest.state.value.tables.map((entry) => ({
						id: entry.id,
						name: entry.name,
						columns:
							focusedDefinition !== undefined &&
							focusedDefinition.id === entry.id
								? focusedDefinition.columns
								: [],
					}))
				: [];
		return {
			definitions,
			byId: new Map(definitions.map((entry) => [entry.id, entry])),
			loadingFocused:
				focusedTableId !== undefined &&
				(focused.state.kind === "loading" ||
					focused.state.kind === "idle" ||
					(focused.state.kind === "data" &&
						manifestEntry !== undefined &&
						lookupContext.kind === "unavailable")),
			loadingList:
				manifest.state.kind === "loading" || manifest.state.kind === "idle",
			lookupContext,
			listFailure:
				manifest.state.kind === "failed"
					? manifest.state.failure.message
					: null,
			focusedFailure:
				focused.state.kind === "failed" ? focused.state.failure.message : null,
			retryList: manifest.reload,
			retryFocused: focused.reload,
		};
	}, [
		manifest.state,
		manifest.reload,
		focused.state,
		focused.reload,
		focusedTableId,
		currentProjectId,
	]);
}
