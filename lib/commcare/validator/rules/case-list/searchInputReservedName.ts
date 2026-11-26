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
import { projectSearchOf } from "@/lib/domain/modules";
import { isProjectSearchParameter } from "../../../hq/projectSearch";
import {
	DEFAULT_FILTER_REQUEST_KEY,
	isReservedSearchInputName,
} from "../../../suite/case-search/reservedInputNames";
import { searchInputSuppressesAutoMatch } from "../../../suite/case-search/searchPrompts";
import { type ValidationError, validationError } from "../../errors";

export function searchInputReservedName(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	const service = projectSearchOf(mod);
	if (service) {
		const issues: ValidationError[] = [];
		const issue = (reason: string, message: string, name?: string) =>
			issues.push(
				validationError(
					"PROJECT_SEARCH_REQUEST",
					"module",
					message,
					{ moduleUuid, moduleName: mod.name },
					name === undefined ? { reason } : { reason, name },
				),
			);
		if (!doc.appSettings.projectSearches?.[service.searchUuid])
			issue("missing-search", "Choose a search that belongs to this app.");
		if (!inputs.length && !service.defaults.length)
			issue(
				"empty-request",
				"Add a search question or a named value for the project space to use.",
			);
		const byName = new Map<string, number>();
		const add = (name: string) => byName.set(name, (byName.get(name) ?? 0) + 1);
		for (const parameter of service.defaults) {
			if (!isProjectSearchParameter(parameter.name))
				issue(
					"reserved-default",
					`“${parameter.name}” controls the search request. Choose a parameter name supplied by the project space.`,
					parameter.name,
				);
			add(parameter.name);
		}
		const names = new Set(byName.keys());
		for (const field of inputs) {
			if (field.kind !== "parameter" && field.kind !== "hidden") {
				issue(
					"unbound-field",
					`Choose how the project space uses “${field.label}” before connecting this search.`,
					field.label,
				);
				continue;
			}
			if (names.has(field.name))
				issue(
					"shared-name",
					`The field “${field.name}” has the same name as a starting parameter. Give the field its own name.`,
					field.name,
				);
			if (field.sendAnswer) {
				if (!isProjectSearchParameter(field.name))
					issue(
						"reserved-field",
						`“${field.name}” controls the search request. Choose a different field name.`,
						field.name,
					);
				add(field.name);
				if (
					field.kind === "parameter" &&
					field.type === "multi-select" &&
					(field.name === "owner_id" ||
						field.name === "commcare_blacklisted_owner_ids")
				)
					issue(
						"single-answer",
						`“${field.name}” takes one answer. Choose a single-answer field.`,
						field.name,
					);
			}
		}
		if (mod.caseSearchConfig?.excludedOwnerIds)
			add("commcare_blacklisted_owner_ids");
		for (const key of ["owner_id", "commcare_blacklisted_owner_ids"])
			if ((byName.get(key) ?? 0) > 1)
				issue(
					"one-source",
					`The project space accepts one value for “${key}”. Choose one place to supply it.`,
					key,
				);
		return issues;
	}
	if (
		inputs.some(
			(field) =>
				field.kind === "parameter" ||
				(field.kind === "hidden" && field.sendAnswer),
		)
	)
		return [
			validationError(
				"PROJECT_SEARCH_REQUEST",
				"module",
				"Choose the search supplied by the project space before adding its parameters.",
				{ moduleUuid, moduleName: mod.name },
				{ reason: "missing-source" },
			),
		];
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
