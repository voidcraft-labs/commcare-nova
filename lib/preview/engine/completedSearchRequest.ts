import type { SearchConfigurationSelection } from "@/lib/case-store/searchRequest";
import {
	type CaseSearchParameter,
	type CaseSearchRequest,
	CaseSearchUnavailableError,
} from "@/lib/case-store/searchRequest";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import {
	SEARCH_RESULTS_CAP,
	searchDetailSupportingRecords,
	searchResultsReadScore,
} from "@/lib/commcare/session";
import {
	readSearchFilterTarget,
	searchFilterKey,
} from "@/lib/commcare/suite/case-search/nativeFilters";
import { includeSearchHierarchy } from "@/lib/commcare/suite/case-search/relatedCaseProjection";
import { requestOrderKey } from "@/lib/commcare/suite/case-search/requestOrder";
import { searchInputSuppressesAutoMatch } from "@/lib/commcare/suite/case-search/searchPrompts";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Module,
	moduleFormsReadSearch,
	splitMultiSelectSearchAnswer,
	takesMultipleSearchChoices,
} from "@/lib/domain";
import { isValidCalendarDate } from "@/lib/domain/calendarDate";
import {
	effectiveFilterForEmission,
	substituteUnansweredSearchInputs,
} from "@/lib/domain/expression";
import {
	expressionReferencesAnySearchInput,
	walkPropertyRefs,
} from "@/lib/domain/expression/walk";
import {
	MULTI_SELECT_SEARCH_ANSWER_DELIMITER,
	parentPathSearchRequestKey,
} from "@/lib/domain/modules";
import { effectiveSearchOrder } from "@/lib/domain/searchOrder";
import type { Uuid } from "@/lib/domain/uuid";
import { searchesForBlank } from "./runtimeBindings";

/** Core splits even a text prompt in its request and discards trailing
 * empty values. A leading blank is a separate HQ matching argument. */
function nativeTextSearchValues(answer: string): string[] {
	const parts = answer.split(MULTI_SELECT_SEARCH_ANSWER_DELIMITER);
	while (parts.at(-1) === "") parts.pop();
	return parts;
}

/** A completed request has its own source order and cap. A search action's
 * Results use its primary matches; an inline datum applies its local detail
 * condition to the instance that arrived. */
export function completedSearchRequest(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
	answers?: ReadonlyMap<string, string>,
	filterValues?: Readonly<Record<string, string>>,
	configuration: SearchConfigurationSelection = {},
	world?: { doc: BlueprintDoc; caseType: string; moduleUuid: Uuid },
	/** The menu's default search ran it, as the list opened: no prompt's
	 *  answer is sent (`CaseSearchRequest.unsentPrompts`). */
	defaultSearch = false,
): CaseSearchRequest {
	const list = module.caseListConfig;
	const search = effectiveCaseSearchConfig(module);
	const additionalRequestTypes = new Set(list?.additionalCaseTypes);
	let relatedRecordProperty = search?.relatedRecordIdProperty;
	const dedicatedHierarchy = !!(
		world &&
		list &&
		includeSearchHierarchy(
			list,
			moduleExpressionContexts(world.doc, world.moduleUuid),
			search?.relatedRecords,
		)
	);
	const hierarchyValues: string[] = dedicatedHierarchy ? ["true"] : [];
	// The default filters' orders reach HQ first, then the dedicated order
	// (`remote_requests.py::_remote_request_query_datums`), and HQ sorts by
	// every `commcare_sort` value in turn (`_parse_commcare_sort_properties`).
	const order = effectiveSearchOrder(
		list?.searchFilters ?? [],
		search?.requestOrder ?? [],
	);
	const parameters = new Map<
		string,
		CaseSearchParameter & { values: string[] }
	>();
	for (const filter of module.caseListConfig?.searchFilters ?? []) {
		if (!("target" in filter)) {
			if (filter.kind === "request-record-type")
				additionalRequestTypes.add(filter.caseType);
			else if (filter.kind === "related-record-id")
				relatedRecordProperty = filter.property;
			continue;
		}
		const key = searchFilterKey(filter.target);
		const value = filterValues?.[filter.uuid];
		if (typeof value !== "string")
			throw new CaseSearchUnavailableError({
				kind: "indexed-value-unavailable",
				field: key,
			});
		if (filter.target.kind === "include-related-records") {
			// HQ tests the request text for truth, including the non-empty string "false".
			hierarchyValues.push(value);
			continue;
		}
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
	const unsentPrompts: string[] = [];
	for (const input of module.caseListConfig?.searchInputs ?? []) {
		if (input.kind !== "simple" || searchInputSuppressesAutoMatch(input))
			continue;
		if (defaultSearch) {
			unsentPrompts.push(input.name);
			continue;
		}
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
		const parentKey = parentPathSearchRequestKey(input);
		const key = parentKey ?? input.name;
		if (
			parentKey !== undefined &&
			input.type === "date" &&
			answer &&
			!isValidCalendarDate(answer)
		)
			throw new CaseSearchUnavailableError({
				kind: "query-value-invalid",
				field: input.label,
			});
		const target = readSearchFilterTarget(key);
		if (target === undefined || target.kind === "include-related-records")
			throw new CaseSearchUnavailableError({
				kind: "indexed-value-unavailable",
				field: input.label,
			});
		const values = [
			...blank,
			...(answer === undefined || answer === ""
				? []
				: parentKey !== undefined && input.type === "text"
					? nativeTextSearchValues(answer)
					: takesMultipleSearchChoices(input.type)
						? splitMultiSelectSearchAnswer(answer)
						: [answer]),
		];
		if (values.length === 0) continue;
		parameters.set(key, {
			key,
			field: input.label || input.name,
			target,
			readsAnswers: true,
			...(parentKey === undefined ? {} : { parentPathPrompt: true as const }),
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
		...(unsentPrompts.length > 0 && { unsentPrompts }),
		...(order.length > 0 && {
			order: order.map((entry) => ({
				key: requestOrderKey(entry),
				type: entry.comparison,
				direction:
					entry.direction === "ascending"
						? ("asc" as const)
						: ("desc" as const),
				...(entry.missing && { missing: entry.missing }),
			})),
		}),
		additionalRequestTypes: [...additionalRequestTypes],
		// HQ unwraps exactly one value. Two values remain a truthy list,
		// including two empty strings.
		includeRelatedHierarchy:
			hierarchyValues.length > 1 || Boolean(hierarchyValues[0]),
		relatedRecordProperty,
		...(world &&
			searchDetailSupportingRecords(world.doc, [
				world.caseType,
				...additionalRequestTypes,
			])),
		configuration,
		maximum: SEARCH_RESULTS_CAP,
		resultCondition,
		readsHitScore,
	};
}
