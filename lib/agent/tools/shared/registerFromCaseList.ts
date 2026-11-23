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
	caseListActionTargetSchema,
	caseListActionVisibilitySchema,
	uuidSchema,
} from "@/lib/domain";

export const registerFromCaseListInputSchema = z.strictObject({
	formUuid: uuidSchema.describe(
		"The form to offer from this list. It stays in the menu which owns it.",
	),
	target: caseListActionTargetSchema
		.nullable()
		.optional()
		.describe(
			"Which record the form works with. Omit to keep this form's existing choice. Use null for a form that registers its own case. For a child it creates, name its case operation UUID. For a follow-up on the selected parent, name the menu that selected that parent.",
		),
	show_when: caseListActionVisibilitySchema
		.nullable()
		.optional()
		.describe(
			"Show the form button when a completed search found nothing or when the condition you give is true. The condition can read choices made before the list; it reads the worker's session, records or a data table only where the list itself reads them. Null shows the button whenever the list opens. Omit to keep the current rule.",
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
	"Offer a form on this menu’s case list. Pick the registration to continue with, or offer a follow-up on the parent record the worker chose. Every form on this menu must open an existing case. A registration follows after_submit unless the form has its own destination or links. A parent follow-up uses its own After submit. Use show_when to control whether the button appears and set_menu_media to change its icon and spoken label. Null removes the button.";

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
	const target =
		input.target === undefined && stored?.formUuid === input.formUuid
			? stored.target
			: input.target;
	const showWhen =
		input.show_when === undefined ? stored?.showWhen : input.show_when;
	return {
		kind: "always",
		...(showWhen != null && { showWhen }),
		formUuid: input.formUuid,
		...(target != null && { target }),
		...(input.label != null && { label: input.label }),
		...(stored?.icon !== undefined && { icon: stored.icon }),
		...(stored?.audioLabel !== undefined && { audioLabel: stored.audioLabel }),
		afterSubmit: input.after_submit ?? stored?.afterSubmit ?? "case-list",
	};
}
