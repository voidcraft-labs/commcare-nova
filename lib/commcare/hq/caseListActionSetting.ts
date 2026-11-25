import { NO_ENTRIES } from "@/lib/domain/records";
import { isJsonObject } from "../reader/jsonCursor";
import { formChoosesCase } from "./entryFacts";

/** Only an action with a condition, one which can open a selected parent's
 * follow-up, or one whose button shows HQ's fallback words in some language
 * depends on FOLLOWUP_FORMS_AS_CASE_LIST_FORM. A blank form id leaves the
 * entire stored block inactive. */
export function sourceUsesCaseListActionSetting(
	raw: Readonly<Record<string, unknown>>,
): boolean {
	const modules = Array.isArray(raw.modules)
		? raw.modules.filter(isJsonObject)
		: [];
	const forms = new Map(
		modules.flatMap((module) =>
			(Array.isArray(module.forms)
				? module.forms.filter(isJsonObject)
				: []
			).map((form) => [form.unique_id, { form, module }] as const),
		),
	);
	const langs = Array.isArray(raw.langs)
		? raw.langs.filter((lang): lang is string => typeof lang === "string")
		: [];
	return modules.some((module) => {
		const action = module.case_list_form;
		if (!isJsonObject(action) || !action.form_id) return false;
		// The words HQ's build writes for a button with no text of its own
		// depend on the setting (`app_strings.py::_create_case_list_form_app_strings`).
		if (labelFallsBack(action.label, langs)) return true;
		if (
			typeof action.relevancy_expression === "string" &&
			action.relevancy_expression.trim() !== ""
		)
			return true;
		const parent = module.parent_select;
		if (!isJsonObject(parent) || parent.active !== true || !parent.module_id)
			return false;
		const target = forms.get(action.form_id);
		if (
			!target ||
			target.module.case_type !==
				modules.find((candidate) => candidate.unique_id === parent.module_id)
					?.case_type
		)
			return false;
		return formChoosesCase(target.form);
	});
}

/**
 * Whether HQ's build gives a list button its fallback words in some app
 * language: `clean_trans` takes the first of the language and the app's
 * languages the label holds a value for (an empty string included), else its
 * first held value, and the build falls back where that is empty.
 */
function labelFallsBack(label: unknown, langs: readonly string[]): boolean {
	const texts: Readonly<Record<string, unknown>> = isJsonObject(label)
		? label
		: NO_ENTRIES;
	const held = Object.keys(texts)
		.filter((key) => texts[key] !== null && texts[key] !== undefined)
		.sort();
	return (langs.length > 0 ? langs : [""]).some((lang) => {
		const chosen = [lang, ...langs].find(
			(candidate) =>
				Object.hasOwn(texts, candidate) &&
				texts[candidate] !== null &&
				texts[candidate] !== undefined,
		);
		const value =
			chosen !== undefined
				? texts[chosen]
				: held.length > 0
					? texts[held[0] as string]
					: "";
		return value === "" || value === undefined;
	});
}
