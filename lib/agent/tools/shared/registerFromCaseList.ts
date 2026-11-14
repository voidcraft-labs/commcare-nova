/**
 * The `register_from_case_list` input of `updateModule`: a registration form
 * of another menu the module's case list always offers
 * (`Module.caseListRegistrationForm`, the `always` arm). The form stays on
 * its own menu; the list's Register button opens it at any time. `null`
 * stops offering it.
 */

import { z } from "zod";
import {
	type AlwaysOfferedRegistration,
	CASE_LIST_REGISTRATION_RETURNS,
	uuidSchema,
} from "@/lib/domain";

export const registerFromCaseListInputSchema = z.strictObject({
	formUuid: uuidSchema.describe(
		"A registration form of this module's case type in another module. It stays on its own menu.",
	),
	label: z
		.string()
		.min(1)
		.nullable()
		.optional()
		.describe(
			'The button\'s text on the case list, such as "Register a new patient"; null or omitted uses ' +
				"the form name.",
		),
	after_submit: z
		.enum(CASE_LIST_REGISTRATION_RETURNS)
		.optional()
		.describe(
			'Where a worker goes after registering from the list: "case-list" returns to the list, ' +
				'"new-case" goes on to this module\'s forms for the new case. Omitted keeps the current ' +
				'choice, or uses "case-list" the first time.',
		),
});

export type RegisterFromCaseListInput = z.infer<
	typeof registerFromCaseListInputSchema
>;

export const REGISTER_FROM_CASE_LIST_DESCRIPTION =
	"Offers a registration form on this module's case list, so a worker can look for a case and add one from the same screen. Every form of this module must open an existing case. after_submit applies while the form's own after submit is Home; a form with its own destination or links goes there from the list too. null stops offering it. Set the button's icon and spoken label with set_menu_media, target case-list-registration. To offer a form only after a search finds nothing, use case_list_registration on the form instead.";

/**
 * The stored arm for what the SA gave. The arm's icon and spoken label are
 * kept from the stored arm, since this input carries neither; a label
 * omitted or null uses the form's name; an omitted `after_submit` keeps the
 * stored choice, or `case-list` on a first offer.
 */
export function alwaysOfferedRegistrationFromInput(
	input: RegisterFromCaseListInput,
	stored: AlwaysOfferedRegistration | undefined,
): AlwaysOfferedRegistration {
	return {
		kind: "always",
		formUuid: input.formUuid,
		...(input.label != null && { label: input.label }),
		...(stored?.icon !== undefined && { icon: stored.icon }),
		...(stored?.audioLabel !== undefined && { audioLabel: stored.audioLabel }),
		afterSubmit: input.after_submit ?? stored?.afterSubmit ?? "case-list",
	};
}
