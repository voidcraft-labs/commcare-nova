import { validateCaseType } from "./identifierValidation";
import type { FormActions, OpenSubCaseAction } from "./types";

/** HQ allocates subcase datums by action position, including inactive actions. */
export function subcaseSessionDatumId(
	subcase: OpenSubCaseAction,
	index: number,
	opensCase: boolean,
): string {
	return `case_id_new_${validateCaseType(subcase.case_type)}_${index + (opensCase ? 1 : 0)}`;
}

/**
 * HQ's basic-form case builder ignores OpenSubCaseAction.relationship. Source
 * XForms carry extension transactions instead. Retain the action's position and
 * type because HQ still allocates its session datum and matches navigation by
 * that type even with condition=never. Its generated case gets relevant=false().
 */
export function hqCaseActions(actions: FormActions): FormActions {
	return {
		...actions,
		subcases: actions.subcases.map((subcase) =>
			subcase.relationship === "extension"
				? {
						...subcase,
						condition: { ...subcase.condition, type: "never" },
					}
				: subcase,
		),
	};
}
