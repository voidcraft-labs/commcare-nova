/**
 * The refusals behind a module's case list registration form
 * (`Module.caseListRegistrationForm`, kind `after-empty-search`): the one
 * registration form of a menu whose forms read the search that opens from
 * Results after a search found nothing, carrying the search answers. It
 * lowers to CommCare's `case_list_form` on the host module plus a hidden
 * module that owns the form, so it is reachable only through the Register
 * action and returns to Results showing the case it registered. Each
 * finding sits at the module and names the form in `details.formUuid`.
 *
 *   - `CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH`: the action's
 *     relevancy reads the inline results instance, which exists only in a
 *     menu whose forms read the search, from search first or from results
 *     first alike.
 *   - `CASE_LIST_REGISTRATION_NOT_REGISTRATION`: CommCare HQ's build
 *     validator admits only a registration form of the module's case type
 *     as a case-list form (`ModuleBaseValidator.validate_case_list_form`),
 *     one whose `open_case` action is active (`FormBase.is_registration_form`),
 *     so its own arm takes Case Management's slot.
 *   - `CASE_LIST_REGISTRATION_MULTIPLE_RETURN`: a several-case host can't
 *     carry the one new case back into its search, so the form returns to
 *     First menu.
 *   - `CASE_LIST_REGISTRATION_HAS_NAVIGATION`: after submit is Results or
 *     explicit `firstMenu`, and the form is never on a menu, so after-submit
 *     links, another after-submit choice, a display condition and
 *     `hiddenFromMenu` have nowhere to act. HQ reads the form's `default`
 *     workflow as a return to the case list, so `firstMenu` (`root`) is the
 *     one explicit destination that leaves it.
 *   - `CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE`: the slot names a form of
 *     the module's own `formOrder`. A move in another module's scope can
 *     strand the slot, so this one runs on every run (`APP_RULES`) and its
 *     code is scope-exempt.
 *   - `FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM` (in `rules/form.ts`):
 *     an after-submit link cannot open a form that lives only behind the
 *     Register action.
 *
 * One slot per module makes a second such form unrepresentable.
 */

import {
	type BlueprintDoc,
	caseSelectionCardinality,
	type Module,
	moduleFormsReadSearch,
	type Uuid,
} from "@/lib/domain";
import { registrationMintsOwnCaseId } from "@/lib/domain/basicCaseSlots";
import { type ValidationError, validationError } from "../../errors";

export function caseListRegistrationForm(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const slot = mod.caseListRegistrationForm;
	if (slot === undefined) return [];
	const { formUuid } = slot;
	// A slot naming a form elsewhere is `caseListRegistrationFormInModule`'s.
	if (!(doc.formOrder[moduleUuid] ?? []).includes(formUuid)) return [];
	const form = doc.forms[formUuid];
	if (form === undefined) return [];
	const loc = { moduleUuid, moduleName: mod.name };
	// The form is named in `details` as well as by uuid: the finding sits at
	// the module, and the builder's sentence names the form.
	const details = { formUuid, formName: form.name };
	const errors: ValidationError[] = [];
	if (!moduleFormsReadSearch(mod)) {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH",
				"module",
				`Module "${mod.name}" offers "${form.name}" when a search finds nothing, but its forms don't read the search, so no search runs before its list. You can turn on Forms read the search for the menu (formsReadSearch true), or stop offering the form (case_list_registration null on update_form).`,
				loc,
				details,
			),
		);
	}
	if (form.type !== "registration") {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_NOT_REGISTRATION",
				"module",
				`Module "${mod.name}" offers "${form.name}" when a search finds nothing, so "${form.name}" needs to register a new "${mod.caseType ?? ""}" case, and it is a ${form.type} form. You can make it a registration form, or stop offering it there.`,
				loc,
				details,
			),
		);
	}
	// HQ's build admits a case-list form only where its `open_case` action is
	// active (`FormBase.is_registration_form`), which is where the own arm
	// takes the basic slot; the return frame also reads the entry's
	// new-case datum, which HQ gives only that action.
	else if (
		mod.caseType !== undefined &&
		!registrationMintsOwnCaseId(doc, formUuid)
	) {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_NOT_REGISTRATION",
				"module",
				`Module "${mod.name}" offers "${form.name}" when a search finds nothing, so CommCare HQ needs Case Management to register its new "${mod.caseType}" case, and "${form.name}" saves that case through Save to Case. You can change the form's case so Case Management can hold it, or stop offering it there.`,
				loc,
				{ ...details, reason: "own-case-save-to-case" },
			),
		);
	}
	// HQ retains the target's collection transport when matching its return query
	// to this form's scalar uuid() datum. Core cannot hydrate that as selected entities.
	if (
		caseSelectionCardinality(mod) === "multiple" &&
		form.postSubmit !== "firstMenu"
	) {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_MULTIPLE_RETURN",
				"module",
				`"${form.name}" registers one case, but "${mod.name}" selects several cases, and CommCare can't carry that new case back into the search. You can set the form's after-submit destination to First menu, or let "${mod.name}" select one case.`,
				loc,
				details,
			),
		);
	}
	const navigation = [
		...((form.formLinks?.length ?? 0) > 0 ? ["after-submit links"] : []),
		...(form.postSubmit !== undefined && form.postSubmit !== "firstMenu"
			? ["an after-submit destination other than First menu"]
			: []),
		...(form.displayCondition !== undefined ? ["a display condition"] : []),
		...(form.hiddenFromMenu === true ? ["hiddenFromMenu"] : []),
	];
	if (navigation.length > 0) {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_HAS_NAVIGATION",
				"module",
				`"${form.name}" is offered when a search finds nothing in "${mod.name}", so after submit it returns to the search or to First menu, and it's on no menu; it can't carry ${navigation.join(", ")}. You can remove them, or stop offering the form there.`,
				loc,
				details,
			),
		);
	}
	return errors;
}

/** The slot names one of the module's own forms. An app rule, so a move
 *  scoped to another module can't leave it standing unseen. */
export function caseListRegistrationFormInModule(
	doc: BlueprintDoc,
): ValidationError[] {
	return doc.moduleOrder.flatMap((moduleUuid) => {
		const mod = doc.modules[moduleUuid];
		const formUuid = mod?.caseListRegistrationForm?.formUuid;
		if (formUuid === undefined) return [];
		if ((doc.formOrder[moduleUuid] ?? []).includes(formUuid)) return [];
		return [
			validationError(
				"CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE",
				"module",
				`Module "${mod.name}" offers a registration form when a search finds nothing, but that form isn't one of "${mod.name}"'s forms. You can choose one of its own registration forms, or stop offering one (caseListRegistrationForm null).`,
				{ moduleUuid, moduleName: mod.name },
				{ formUuid },
			),
		];
	});
}
