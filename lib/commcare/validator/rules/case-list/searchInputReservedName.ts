/**
 * Rule: no Search question is named like a key CommCare HQ reads as part of
 * the search request.
 *
 * Two refusals, by one derived set (`suite/case-search/reservedInputNames.ts`):
 *
 *   - `CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER`: any input named
 *     `_xpath_query`, on every route. Nova writes every default filter as an
 *     `_xpath_query` row, and HQ's Case List page refuses a prompt named like
 *     one of the menu's default filters
 *     (`static/app_manager/js/details/case_claim.js::searchViewModel.commonProperties`).
 *   - `CASE_LIST_SEARCH_INPUT_NAME_RESERVED`: an input that reaches HQ as its
 *     own request key (`!searchInputSuppressesAutoMatch(input)`) under a
 *     reserved name. HQ takes such a key as a setting, ignores it, or filters
 *     by something else with it (`case_search/utils.py::CaseSearchQueryBuilder`),
 *     so the input never searches the property it names. An input whose
 *     comparison rides `_xpath_query` is sent with `exclude`, so its name is
 *     only a handle and any name but `_xpath_query` is free.
 *
 * `case_id` and `owner_id` are outside the set: HQ searches them as the
 * case's id and its owner, which is what an exact input on them means.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	DEFAULT_FILTER_REQUEST_KEY,
	isReservedSearchInputName,
} from "../../../suite/case-search/reservedInputNames";
import { searchInputSuppressesAutoMatch } from "../../../suite/case-search/searchPrompts";
import { type ValidationError, validationError } from "../../errors";

export function searchInputReservedName(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	const errors: ValidationError[] = [];
	for (const [index, input] of inputs.entries()) {
		const code =
			input.name === DEFAULT_FILTER_REQUEST_KEY
				? "CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER"
				: !searchInputSuppressesAutoMatch(input) &&
						isReservedSearchInputName(input.name)
					? "CASE_LIST_SEARCH_INPUT_NAME_RESERVED"
					: undefined;
		if (code === undefined) continue;
		errors.push(
			validationError(
				code,
				"module",
				`Search input "${input.name}" in "${mod.name}" uses a name CommCare reads as part of the search request, so it would never search a case property. Rename the input.`,
				{ moduleUuid, moduleName: mod.name },
				{
					index: String(index),
					inputName: input.name,
					inputUuid: input.uuid,
				},
			),
		);
	}
	return errors;
}
