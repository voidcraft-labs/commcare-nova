import type { SearchConfigurationSelection } from "@/lib/case-store/searchRequest";
import {
	type CaseSearchParameter,
	type CaseSearchRequest,
	CaseSearchUnavailableError,
} from "@/lib/case-store/searchRequest";
import {
	SEARCH_RESULTS_CAP,
	searchDetailRelatedPaths,
	searchResultsReadScore,
} from "@/lib/commcare/session";
import {
	readSearchFilterTarget,
	searchFilterKey,
} from "@/lib/commcare/suite/case-search/nativeFilters";
import { searchInputSuppressesAutoMatch } from "@/lib/commcare/suite/case-search/searchPrompts";
import {
	type BlueprintDoc,
	type Module,
	moduleFormsReadSearch,
	splitMultiSelectSearchAnswer,
	takesMultipleSearchChoices,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	substituteUnansweredSearchInputs,
} from "@/lib/domain/expression";
import {
	expressionReferencesAnySearchInput,
	walkPropertyRefs,
} from "@/lib/domain/expression/walk";
import { searchesForBlank } from "./runtimeBindings";

/** A completed request has its own source order and cap. A search action's
 * Results use its primary matches; an inline datum applies its local detail
 * condition to the instance that arrived. */
export function completedSearchRequest(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
	answers?: ReadonlyMap<string, string>,
	filterValues?: Readonly<Record<string, string>>,
	configuration: SearchConfigurationSelection = {},
	world?: { doc: BlueprintDoc; caseType: string },
): CaseSearchRequest {
	const parameters = new Map<
		string,
		CaseSearchParameter & { values: string[] }
	>();
	for (const filter of module.caseListConfig?.searchFilters ?? []) {
		const key = searchFilterKey(filter.target);
		const value = filterValues?.[filter.uuid];
		if (typeof value !== "string")
			throw new CaseSearchUnavailableError({
				kind: "indexed-value-unavailable",
				field: key,
			});
		const existing = parameters.get(key);
		parameters.set(key, {
			key,
			field: key,
			target: filter.target,
			values: [...(existing?.values ?? []), value],
			readsAnswers:
				existing?.readsAnswers ||
				expressionReferencesAnySearchInput(filter.value),
		});
	}
	for (const input of module.caseListConfig?.searchInputs ?? []) {
		if (input.kind !== "simple" || searchInputSuppressesAutoMatch(input))
			continue;
		const start = answers?.get(`${input.name}:from`);
		const end = answers?.get(`${input.name}:to`);
		const answer =
			input.type === "date-range"
				? start && end && `__range__${start}__${end}`
				: answers?.get(input.name);
		// A ticked "search for blank" is a blank value before the answer, which Core
		// sends as one more value of the key (`query.js::encodeValue`,
		// `RemoteQuerySessionManager.getRawQueryParams`).
		const blank =
			answers !== undefined && searchesForBlank(input, answers) ? [""] : [];
		if ((answer === undefined || answer === "") && blank.length === 0) continue;
		const target = readSearchFilterTarget(input.name);
		if (target === undefined)
			throw new CaseSearchUnavailableError({
				kind: "indexed-value-unavailable",
				field: input.label,
			});
		const values = [
			...blank,
			...(answer === undefined || answer === ""
				? []
				: takesMultipleSearchChoices(input.type)
					? splitMultiSelectSearchAnswer(answer)
					: [answer]),
		];
		parameters.set(input.name, {
			key: input.name,
			field: input.label || input.name,
			target,
			readsAnswers: true,
			values,
		});
	}
	const resultCondition =
		moduleFormsReadSearch(module) && module.caseListConfig?.filter !== undefined
			? effectiveFilterForEmission(
					substituteUnansweredSearchInputs(module.caseListConfig.filter),
				)
			: undefined;
	let readsHitScore = searchResultsReadScore(module.caseListConfig);
	if (resultCondition)
		walkPropertyRefs(resultCondition, (property) => {
			if (!property.via && property.property === "commcare_search_score")
				readsHitScore = true;
		});
	return {
		parameters: [...parameters.values()],
		...(world && {
			relatedPaths: searchDetailRelatedPaths(world.doc, [world.caseType]),
		}),
		configuration,
		maximum: SEARCH_RESULTS_CAP,
		resultCondition,
		readsHitScore,
	};
}
