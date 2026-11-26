/**
 * The `case_list_registration` input the form tools share: the form is its
 * menu's registration from the case list (`Module.caseListRegistrationForm`),
 * offered on the results after a search finds nothing and on no menu.
 * `updateForm` takes `null` to make it a menu form again.
 */

import { z } from "zod";
import {
	CASE_LIST_REGISTRATION_RETURNS,
	type CaseListRegistrationReturn,
} from "@/lib/domain";

export const caseListRegistrationInputSchema = z.strictObject({
	after_submit: z
		.enum(CASE_LIST_REGISTRATION_RETURNS)
		.nullable()
		.optional()
		.describe(
			"After registering from this list: return to the search results (case-list) or continue with the new case selected (new-case). With no new case, workers return to the list. Omit to keep the current choice; null resets it to case-list.",
		),
	label: z
		.string()
		.min(1)
		.nullable()
		.optional()
		.describe(
			'The button\'s text on the results, such as "Register a new patient"; null or omitted uses the form name.',
		),
});

export const CASE_LIST_REGISTRATION_DESCRIPTION =
	"Makes this registration form its menu's registration from the case list: the results offer it after a search finds nothing, and it is on no menu. This turns on formsReadSearch for the menu, so the form's fields can read #search/<name>. After submit the list follows after_submit, unless the form opens the first menu (post_submit firstMenu), which a menu choosing several cases requires. It takes no links, otherwise, display condition or hiddenFromMenu. To offer a form that stays on its own menu from a case list at any time, use register_from_case_list on update_module.";

/** The stored label for what the SA gave: null and omission both use the
 * form's name. */
export function caseListRegistrationEntry(
	input: z.infer<typeof caseListRegistrationInputSchema>,
): { label?: string; afterSubmit?: CaseListRegistrationReturn } {
	return {
		...(input.label != null && { label: input.label }),
		...(input.after_submit !== undefined && {
			afterSubmit: input.after_submit ?? "case-list",
		}),
	};
}
