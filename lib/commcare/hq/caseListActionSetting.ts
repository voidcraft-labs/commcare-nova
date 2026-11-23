import { isJsonObject } from "../reader/jsonCursor";
import { formChoosesCase } from "./entryFacts";

/** Only an action with a condition or one which can open a selected parent's
 * follow-up depends on FOLLOWUP_FORMS_AS_CASE_LIST_FORM. A blank form id
 * leaves the entire stored block inactive. */
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
	return modules.some((module) => {
		const action = module.case_list_form;
		if (!isJsonObject(action) || !action.form_id) return false;
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
