/**
 * The `case_list_registration` input the form tools share: the form is its
 * menu's registration from the case list (`Module.caseListRegistrationForm`),
 * offered on the results after a search finds nothing and on no menu.
 * `updateForm` takes `null` to make it a menu form again.
 */

import { z } from "zod";

export const caseListRegistrationInputSchema = z.strictObject({
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
	"Makes this registration form its menu's registration from the case list: the results offer it after a search finds nothing, and it is on no menu. This turns on formsReadSearch for the menu, so the form's fields can read #search/<name>. After submit it returns to the results, or to the first menu when post_submit is firstMenu, which a menu choosing several cases requires. It takes no links, otherwise, display condition or hiddenFromMenu.";

/** The stored label for what the SA gave: null and omission both use the
 * form's name. */
export function caseListRegistrationEntry(
	input: z.infer<typeof caseListRegistrationInputSchema>,
): { label?: string } {
	return input.label == null ? {} : { label: input.label };
}
