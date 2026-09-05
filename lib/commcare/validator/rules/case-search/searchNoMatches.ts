/**
 * The refusals behind the no-matches registration form (`Form.entry` of
 * kind `search-no-matches`): the one form of a search-first module that
 * opens from Results after a search found nothing, carrying the search
 * answers. It lowers to CommCare's `case_list_form` on the host module plus
 * a hidden module that owns the form, so it is reachable only through the
 * Register action and returns to Results showing the case it registered.
 *
 *   - `SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST`: the action's
 *     relevancy reads the inline results instance, which exists only in a
 *     module that opens on Search.
 *   - `SEARCH_NO_MATCHES_ENTRY_NOT_REGISTRATION`: CommCare HQ's build
 *     validator admits only a registration form of the module's case type
 *     as a case-list form (`ModuleBaseValidator.validate_case_list_form`).
 *   - `SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION`: after submit is Results
 *     or explicit App home, and the form is never on a
 *     menu, so after-submit links, an after-submit choice, and a display
 *     condition have nowhere to act.
 *   - `SEARCH_NO_MATCHES_ENTRY_PARENT_NEEDS_MENU_FORM`: the Register
 *     action carries a parent selection into the form only by copying it
 *     from the host's first menu form (`DetailContributor.get_datums_for_action`
 *     matches the target's selection datums against that form's and drops
 *     an unmatched one), so a host that selects a parent case first needs a
 *     menu form for the registration to know its parent.
 *   - `SEARCH_NO_MATCHES_DUPLICATE`: a module carries at most one
 *     `case_list_form`.
 *   - `FORM_LINK_TARGET_NO_MATCHES_FORM` (in `rules/form.ts`): an
 *     after-submit link cannot open a form that lives only behind the
 *     Register action.
 */

import {
	formLinkProjectionContext,
	parentSelectModuleUuid,
} from "@/lib/commcare/formLinkProjection";
import {
	type BlueprintDoc,
	caseSelectionCardinality,
	type Form,
	isNoMatchesForm,
	type Module,
	menuFormUuidsOf,
	moduleOpensOnSearch,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function searchNoMatchesEntry(
	doc: BlueprintDoc,
	form: Form,
	formUuid: Uuid,
	moduleUuid: Uuid,
): ValidationError[] {
	if (!isNoMatchesForm(form)) return [];
	const mod = doc.modules[moduleUuid];
	const loc = {
		moduleUuid,
		moduleName: mod.name,
		formUuid,
		formName: form.name,
	};
	const errors: ValidationError[] = [];
	if (!moduleOpensOnSearch(mod)) {
		errors.push(
			validationError(
				"SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST",
				"form",
				`Form "${form.name}" opens after a search finds no matches, but module "${mod.name}" does not open on Search, so no search runs before its list. Turn Search first on for the module (caseSearchConfig.searchFirst), or clear the form's entry.`,
				loc,
			),
		);
	}
	if (form.type !== "registration") {
		errors.push(
			validationError(
				"SEARCH_NO_MATCHES_ENTRY_NOT_REGISTRATION",
				"form",
				`Form "${form.name}" opens after a search finds no matches, so it must register a new "${mod.caseType ?? ""}" case, but it is a ${form.type} form. Make it a registration form, or clear the form's entry.`,
				loc,
			),
		);
	}
	// HQ retains the target's collection transport when matching its return query
	// to this form's scalar uuid() datum. Core cannot hydrate that as selected entities.
	if (
		caseSelectionCardinality(mod) === "multiple" &&
		form.postSubmit !== "app_home"
	) {
		errors.push(
			validationError(
				"SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN",
				"form",
				`Form "${form.name}" registers one case, but "${mod.name}" selects several cases. CommCare cannot carry that new case back into the collection search. Set this form's after-submit destination to App home, or change the module to one-case selection.`,
				loc,
			),
		);
	}
	const navigation = [
		...((form.formLinks?.length ?? 0) > 0 ? ["after-submit links"] : []),
		...(form.postSubmit !== undefined && form.postSubmit !== "app_home"
			? ["an after-submit destination other than App home"]
			: []),
		...(form.displayCondition !== undefined ? ["a display condition"] : []),
	];
	if (navigation.length > 0) {
		errors.push(
			validationError(
				"SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION",
				"form",
				`Form "${form.name}" opens after a search finds no matches, so after submit it can return to the module's search or App home and is never on a menu; it cannot carry ${navigation.join(", ")}. Remove them, or clear the form's entry.`,
				loc,
			),
		);
	}
	if (
		menuFormUuidsOf(doc, moduleUuid).length === 0 &&
		parentSelectModuleUuid(doc, formLinkProjectionContext(doc), moduleUuid) !==
			undefined
	) {
		errors.push(
			validationError(
				"SEARCH_NO_MATCHES_ENTRY_PARENT_NEEDS_MENU_FORM",
				"form",
				`Form "${form.name}" opens after a search finds no matches in module "${mod.name}", which selects a "${mod.caseType ?? ""}" case's parent first, but the module has no menu form, and CommCare carries that parent into the registration only from the module's first menu form. Add a menu form to the module, or clear the form's entry.`,
				loc,
			),
		);
	}
	return errors;
}

export function searchNoMatchesFormUnique(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const noMatches = (doc.formOrder[moduleUuid] ?? []).flatMap((formUuid) => {
		const form = doc.forms[formUuid];
		return form !== undefined && isNoMatchesForm(form) ? [form] : [];
	});
	if (noMatches.length < 2) return [];
	return [
		validationError(
			"SEARCH_NO_MATCHES_DUPLICATE",
			"module",
			`Module "${mod.name}" has ${noMatches.length} forms that open after a search finds no matches (${noMatches.map((form) => `"${form.name}"`).join(", ")}), but Results can offer only one. Keep one and clear the entry on the others.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}
