// lib/preview/engine/searchResultsSnapshot.ts
//
// What a completed search returns to the forms of its search-first module:
// the `results:inline` instance a device's session keeps on the query step
// (`org/commcare/session/CommCareSession.java::setQueryDatum`).
//
// Forms read the primary server result before an inline detail filters or
// pages it. The store certifies the cutoff before a row reaches either
// surface; an unresolved cutoff refuses the snapshot as well as the list.
//
// The snapshot is plain JSON, as every case-data Server Action's result is.

import "server-only";
import type { CaseStore } from "@/lib/case-store";
import { CaseSearchUnavailableError } from "@/lib/case-store/searchRequest";
import { SEARCH_RESULTS_CAP } from "@/lib/commcare/session";
import {
	type readCases,
	runningCaseSelectionQuery,
} from "./caseDataBindingHelpers";
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
	store: Pick<CaseStore, "readSearchResultInstance">,
	read: SearchRead,
	readsHitScore = false,
): Promise<SearchResultsSnapshot> {
	const { searchPopulation, ...base } = read;
	const { rows, indices, primaryIds } = await store.readSearchResultInstance(
		runningCaseSelectionQuery({
			...base,
			searchPopulation: {
				...searchPopulation,
				...(base.caseIds === undefined || searchPopulation.request !== undefined
					? {
							request: {
								maximum: SEARCH_RESULTS_CAP,
								...searchPopulation.request,
								readsHitScore,
							},
						}
					: {}),
			},
		}),
	);
	if (readsHitScore && primaryIds.length)
		throw new CaseSearchUnavailableError({ kind: "hit-score-unavailable" });
	const primary = new Set(primaryIds);
	const indicesByCase = new Map<string, SearchResultRow["indices"][number][]>();
	for (const index of indices) {
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
			properties: primary.has(row.case_id)
				? Object.fromEntries(
						Object.entries(row.properties).filter(
							([name]) => name !== "commcare_search_score",
						),
					)
				: { ...row.properties, commcare_is_related_case: "true" },
			status: row.status === "closed" ? "closed" : "open",
			indices: indicesByCase.get(row.case_id) ?? [],
		})),
		totalMatches: primaryIds.length,
	};
}
