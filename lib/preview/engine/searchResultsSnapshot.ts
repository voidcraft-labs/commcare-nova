// lib/preview/engine/searchResultsSnapshot.ts
//
// What a completed search returns to the forms of its search-first module:
// the `results:inline` instance a device's session keeps on the query step
// (`org/commcare/session/CommCareSession.java::setQueryDatum`).
//
// The read is the one Results runs for that search, in the search reading
// with HQ's population (the Project's open cases of the module's type, with
// its owner exclusion and filters, bound by no restore), in Results' order,
// without a page window, and limited to `SEARCH_RESULTS_CAP`, the most
// primary cases HQ's case search sends (`case_search/const.py::CASE_SEARCH_MAX_RESULTS`).
// HQ's 500 are the first by relevance and Preview's the first in Results'
// order; the checker refuses every read whose answer depends on which.
//
// The snapshot is plain JSON, as every case-data Server Action's result is.

import "server-only";
import type { CaseStore } from "@/lib/case-store";
import { SEARCH_RESULTS_CAP } from "@/lib/commcare/session";
import { readCases } from "./caseDataBindingHelpers";
import type { CaseRow } from "./caseDataBindingTypes";
import type { SearchResultRow, SearchResultsSnapshot } from "./xpathInstances";

type SearchRead = Omit<
	Parameters<typeof readCases>[1],
	"page" | "cap" | "restoreScope" | "searchPopulation"
> & {
	readonly searchPopulation: NonNullable<
		Parameters<typeof readCases>[1]["searchPopulation"]
	>;
};

function instantText(value: Date | string | null): string | null {
	if (value === null) return null;
	const instant = value instanceof Date ? value : new Date(value);
	return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/** Run a completed search's read and keep what its forms read. */
export async function readSearchResultsSnapshot(
	store: Pick<
		CaseStore,
		"query" | "count" | "queryGrouped" | "readCaseDatabasePatch"
	>,
	read: SearchRead,
): Promise<SearchResultsSnapshot> {
	const result = await readCases(store, { ...read, cap: SEARCH_RESULTS_CAP });
	if (result.kind !== "rows") return { rows: [], totalMatches: 0 };
	const rows: readonly CaseRow[] = result.rows;
	/* Each row's `index` children: its direct indices, read by id from the
	 * same store (an App Test's reads its own namespace). */
	const patch =
		rows.length === 0
			? { indices: [] }
			: await store.readCaseDatabasePatch({
					appId: read.appId,
					caseIds: rows.map((row) => row.case_id),
				});
	const indicesByCase = new Map<string, SearchResultRow["indices"][number][]>();
	for (const index of patch.indices) {
		const list = indicesByCase.get(index.case_id) ?? [];
		list.push({
			identifier: index.identifier,
			ancestor_id: index.ancestor_id,
			target_case_type: index.target_case_type,
			relationship: index.relationship,
		});
		indicesByCase.set(index.case_id, list);
	}
	return {
		rows: rows.map((row) => ({
			case_id: row.case_id,
			case_type: row.case_type,
			owner_id: row.owner_id,
			case_name: row.case_name,
			opened_on: instantText(row.opened_on),
			modified_on: instantText(row.modified_on),
			external_id: row.external_id,
			properties: row.properties,
			indices: indicesByCase.get(row.case_id) ?? [],
		})),
		totalMatches: result.totalCount ?? rows.length,
	};
}
