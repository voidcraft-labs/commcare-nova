import {
	isOrdinaryCaseSearchConfig,
	type Module,
	moduleSearchWorkflow,
	requestedRecordTypes,
	type SearchFilter,
	type SearchRequestOrder,
} from "./modules";

export function moduleAllowsSearchIndexFallback(module: Module): boolean {
	const search = module.caseSearchConfig;
	const list = module.caseListConfig;
	return (
		isOrdinaryCaseSearchConfig(search) &&
		moduleSearchWorkflow(module) === "skipToResults" &&
		!search.formsReadSearch &&
		search.requestOrder === undefined &&
		search.relatedRecordIdProperty === undefined &&
		search.relatedRecords === undefined &&
		module.heldKind !== "advanced" &&
		module.caseType !== undefined &&
		requestedRecordTypes(module.caseType, list).length === 1 &&
		(list?.searchInputs.length ?? 0) === 0 &&
		(list?.searchFilters ?? []).every((row) => "order" in row)
	);
}

export function searchOrderResetPosition(
	filters: readonly SearchFilter[],
): number {
	return filters.findLastIndex(
		(filter) =>
			"order" in filter &&
			filter.order.some((term) => term.comparison === "indexed-fallback"),
	);
}

type EffectiveOrderTerm = SearchRequestOrder[number] & { missing?: "last" };

/** HQ discards every earlier sort at the blank built-in comparison, then
 * appends the remaining ordinary terms in their request order. */
export function effectiveSearchOrder(
	filters: readonly SearchFilter[],
	dedicated: readonly SearchRequestOrder[number][],
): EffectiveOrderTerm[] {
	const resetPosition = searchOrderResetPosition(filters);
	return [
		...filters
			.slice(Math.max(resetPosition, 0))
			.flatMap((filter): EffectiveOrderTerm[] =>
				"order" in filter
					? filter.order.flatMap((term): EffectiveOrderTerm[] =>
							term.comparison === "indexed-fallback"
								? (["number", "date", "text"] as const).map((comparison) => ({
										property: term.property,
										direction: "ascending",
										comparison,
										missing: "last",
									}))
								: [term],
						)
					: [],
			),
		...dedicated,
	];
}
