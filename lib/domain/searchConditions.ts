import { canonicalJsonText } from "../utils/canonicalJsonText";
import { effectiveFilterForEmission } from "./expression/simplify";
import type { Expression } from "./expression/types";
import { walkExpression } from "./expression/walk";
import type { CaseListConfig } from "./modules";

type Conditions = Pick<CaseListConfig, "filter" | "searchCondition">;

/**
 * Whether a condition reads a Search field: the worker's answer, or whether
 * the worker answered it. A top-level conjunct of a Search field's own
 * condition that reads none is a condition on the whole search, not on that
 * field: the search sends it with the search condition's rows, ahead of every
 * field's (`xpathQuery.ts::composeXPathQueryClauses`), and a reading of the
 * search returns it as the search condition (`search/rows.ts`).
 */
export function readsSearchField(expression: Expression): boolean {
	let reads = false;
	walkExpression(expression, {
		visitExpression: (node) => {
			if (node.kind === "when-input-present") reads = true;
		},
		visitTerm: (term) => {
			if (term.kind === "input") reads = true;
		},
	});
	return reads;
}

export function searchConditionOf(
	config: Conditions | undefined,
): Expression | undefined {
	return config?.searchCondition ?? config?.filter;
}

/**
 * Whether a case list's Search keeps sending something once it has no
 * field: an effective search condition, or a search filter. Either keeps
 * the Search action, so the last field's removal leaves it in place
 * (`modules.ts::caseSearchConfigAfterFinalInputRemoval`).
 */
export function searchContentWithoutInputs(
	config:
		| Pick<CaseListConfig, "filter" | "searchCondition" | "searchFilters">
		| undefined,
): boolean {
	return (
		effectiveFilterForEmission(searchConditionOf(config)) !== undefined ||
		(config?.searchFilters?.length ?? 0) > 0
	);
}

export function searchConditionSlot(config: Conditions | undefined) {
	return config?.searchCondition === undefined
		? "case_list_filter"
		: "case_search_filter";
}

/** Absence of an override carries the list's effective condition to search
 * in old documents. An explicit all-records arm keeps the two independent. */
export function replaceCaseConditions(
	config: Conditions,
	patch: {
		filter?: Expression | null;
		listCondition?: Expression | null;
		searchCondition?: Expression | null;
	},
): void {
	const previousSearch = searchConditionOf(config);
	const list =
		patch.listCondition !== undefined
			? (patch.listCondition ?? undefined)
			: patch.filter !== undefined
				? (patch.filter ?? undefined)
				: config.filter;
	const search =
		patch.searchCondition !== undefined
			? (patch.searchCondition ?? undefined)
			: patch.filter !== undefined
				? (patch.filter ?? undefined)
				: previousSearch;
	if (list === undefined) delete config.filter;
	else config.filter = list;
	const effectiveList = effectiveFilterForEmission(list);
	const effectiveSearch = effectiveFilterForEmission(search);
	if (
		effectiveList === effectiveSearch ||
		canonicalJsonText(effectiveList ?? null) ===
			canonicalJsonText(effectiveSearch ?? null)
	)
		delete config.searchCondition;
	else config.searchCondition = search ?? { kind: "match-all" };
}
