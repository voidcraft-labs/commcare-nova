/**
 * The refusals behind a module's case list registration
 * (`Module.caseListRegistrationForm`), a registration form the module's case
 * list offers. It lowers to CommCare's `case_list_form` on the host module.
 * Every finding sits at the host module and names the form in
 * `details.formUuid`. The slot has two arms.
 *
 * The `after-empty-search` arm names one registration form of a menu whose
 * forms read the search, which opens from Results after a search found
 * nothing, carrying the search answers. It also lowers to a hidden module
 * that owns the form, so it is reachable only through the Register action
 * and returns to Results showing the case it registered.
 *
 *   - `CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH` (module rule): the
 *     action's relevancy reads the inline results instance, which exists
 *     only in a menu whose forms read the search, from search first or from
 *     results first alike.
 *   - `CASE_LIST_REGISTRATION_HAS_NAVIGATION` (module rule): after submit is
 *     Results or explicit `firstMenu`, and the form is never on a menu, so
 *     after-submit links, another after-submit choice, a display condition
 *     and `hiddenFromMenu` have nowhere to act. HQ reads the form's
 *     `default` workflow as a return to the case list, so `firstMenu`
 *     (`root`) is the one explicit destination that leaves it.
 *   - `CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE` (app rule): the slot names
 *     a form of the module's own `formOrder`. A move in another module's
 *     scope can strand the slot, so this one runs on every run.
 *   - `FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM` (in `rules/form.ts`):
 *     an after-submit link cannot open a form that lives only behind the
 *     Register action.
 *
 * The `always` arm names a registration form of the host's case type in
 * another menu, which stays on its own menu and which the host's case list
 * always offers. Its findings come from `caseListRegistrationApp` alone, an
 * app rule because the arm reads a form in another module.
 *
 * Both arms share two findings, which the app rule emits too:
 *
 *   - `CASE_LIST_REGISTRATION_NOT_REGISTRATION`: CommCare HQ's build admits
 *     only a registration form of the host's case type as a case-list form
 *     (`helpers/validators.py::ModuleBaseValidator.validate_case_list_form`),
 *     one with exactly one registration action for that type
 *     (`models/forms.py::FormBase.is_registration_form`, counted over the
 *     form's `open_case` and every subcase of the type outside a repeat by
 *     `Form.get_registration_actions`). So its own arm takes Case
 *     Management's slot, and no basic child of the host's type stands at its
 *     root (`basicCaseSlots.ts::rootBasicSubcaseCreates`).
 *   - `CASE_LIST_REGISTRATION_MULTIPLE_RETURN`: a several-case host can't
 *     carry the one new case back into a selection of several.
 *
 * Every code the app rule emits is scope-exempt (`runner.ts`), since one
 * walk must produce each code for a scoped run to equal the filtered full
 * run. One slot per module makes a second such form unrepresentable.
 */

import {
	afterEmptySearchRegistrationFormOf,
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	type Module,
	menuFormUuidsOf,
	moduleFormsReadSearch,
	moduleShowsFormsInMenuAbove,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import {
	registrationMintsOwnCaseId,
	rootBasicSubcaseCreates,
} from "@/lib/domain/basicCaseSlots";
import { emittedModuleKind } from "../../../moduleKind";
import { type ValidationError, validationError } from "../../errors";
import { caseListReturnSharesFirstMenuCase } from "../formsInMenuAbove";

/** The module rule: the `after-empty-search` arm's findings that read the
 *  host alone. The `always` arm and the shared findings are
 *  `caseListRegistrationApp`'s. */
export function caseListRegistrationForm(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const slot = mod.caseListRegistrationForm;
	if (slot?.kind !== "after-empty-search") return [];
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
		const formUuid = afterEmptySearchRegistrationFormOf(doc, moduleUuid);
		if (mod === undefined || formUuid === undefined) return [];
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

/** The first basic child the form creates at its root of `caseType`: a
 *  second registration of that type to CommCare HQ's count. */
function rootRegistrationOfType(
	doc: BlueprintDoc,
	formUuid: Uuid,
	caseType: string,
): Uuid | undefined {
	return rootBasicSubcaseCreates(doc, formUuid).find(
		(create) => create.caseType === caseType,
	)?.operationUuid;
}

/**
 * The app rule: every finding of both arms that is not the module rule's.
 * For the `after-empty-search` arm, `CASE_LIST_REGISTRATION_NOT_REGISTRATION`
 * and `CASE_LIST_REGISTRATION_MULTIPLE_RETURN`; for the `always` arm, every
 * finding.
 */
export function caseListRegistrationApp(doc: BlueprintDoc): ValidationError[] {
	return doc.moduleOrder.flatMap((moduleUuid) => {
		const mod = doc.modules[moduleUuid];
		const slot = mod?.caseListRegistrationForm;
		if (mod === undefined || slot === undefined) return [];
		return slot.kind === "after-empty-search"
			? afterEmptySearchFindings(doc, mod, moduleUuid, slot.formUuid)
			: alwaysFindings(doc, mod, moduleUuid, slot.formUuid, slot.afterSubmit);
	});
}

function afterEmptySearchFindings(
	doc: BlueprintDoc,
	mod: Module,
	moduleUuid: Uuid,
	formUuid: Uuid,
): ValidationError[] {
	// A slot naming a form elsewhere is `caseListRegistrationFormInModule`'s.
	if (!(doc.formOrder[moduleUuid] ?? []).includes(formUuid)) return [];
	const form = doc.forms[formUuid];
	if (form === undefined) return [];
	const loc = { moduleUuid, moduleName: mod.name };
	const details = { formUuid, formName: form.name };
	const errors: ValidationError[] = [];
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
	} else if (mod.caseType !== undefined) {
		const secondCreate = rootRegistrationOfType(doc, formUuid, mod.caseType);
		// HQ's build admits a case-list form only where its `open_case` action
		// is active (`FormBase.is_registration_form`), which is where the own
		// arm takes the basic slot; the return frame also reads the entry's
		// new-case datum, which HQ gives only that action.
		if (!registrationMintsOwnCaseId(doc, formUuid)) {
			errors.push(
				validationError(
					"CASE_LIST_REGISTRATION_NOT_REGISTRATION",
					"module",
					`Module "${mod.name}" offers "${form.name}" when a search finds nothing, so CommCare HQ needs Case Management to register its new "${mod.caseType}" case, and "${form.name}" saves that case through Save to Case. You can change the form's case so Case Management can hold it, or stop offering it there.`,
					loc,
					{ ...details, reason: "own-case-save-to-case" },
				),
			);
		} else if (secondCreate !== undefined) {
			errors.push(
				validationError(
					"CASE_LIST_REGISTRATION_NOT_REGISTRATION",
					"module",
					`Module "${mod.name}" offers "${form.name}" when a search finds nothing, but "${form.name}" registers more than one "${mod.caseType}" case, and CommCare HQ offers a form from a case list only where it registers one. You can move the other "${mod.caseType}" case into a repeat or to another form, or stop offering "${form.name}" there.`,
					loc,
					{
						...details,
						reason: "several-registrations",
						caseType: mod.caseType,
						operationUuid: secondCreate,
					},
				),
			);
		}
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
	return errors;
}

/** The first reason the `always` arm's form is no registration form CommCare
 *  HQ offers from the host's list, or undefined. */
function alwaysNotRegistration(
	doc: BlueprintDoc,
	host: Module,
	hostUuid: Uuid,
	formUuid: Uuid,
	formModuleUuid: Uuid,
): ValidationError | undefined {
	const form = doc.forms[formUuid];
	const formModule = doc.modules[formModuleUuid];
	const caseType = host.caseType;
	// A host with no case type is `CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST`'s.
	if (form === undefined || formModule === undefined || caseType === undefined)
		return undefined;
	const loc = { moduleUuid: hostUuid, moduleName: host.name };
	const details = {
		formUuid,
		formName: form.name,
		kind: "always",
		caseType,
	};
	const refuse = (
		reason: string,
		message: string,
		extra: Record<string, string> = {},
	) =>
		validationError(
			"CASE_LIST_REGISTRATION_NOT_REGISTRATION",
			"module",
			message,
			loc,
			{ ...details, reason, ...extra },
		);
	if (form.type !== "registration")
		return refuse(
			"form-type",
			`"${host.name}" offers "${form.name}" on its case list, so "${form.name}" needs to register a new "${caseType}" case, and it is a ${form.type} form. You can choose a registration form, or stop offering it there.`,
			{ formType: form.type },
		);
	if (formModule.caseType !== caseType)
		return refuse(
			"case-type",
			`"${host.name}" lists "${caseType}" cases and offers "${form.name}" on its case list, but "${form.name}" registers a "${formModule.caseType ?? ""}" case in "${formModule.name}". You can choose a form that registers a "${caseType}" case, or stop offering it there.`,
			{
				formCaseType: formModule.caseType ?? "",
				formModuleName: formModule.name,
			},
		);
	if (!registrationMintsOwnCaseId(doc, formUuid))
		return refuse(
			"own-case-save-to-case",
			`"${host.name}" offers "${form.name}" on its case list, so CommCare HQ needs Case Management to register its new "${caseType}" case, and "${form.name}" saves that case through Save to Case. You can change the form's case so Case Management can hold it, or stop offering it there.`,
		);
	const secondCreate = rootRegistrationOfType(doc, formUuid, caseType);
	if (secondCreate !== undefined)
		return refuse(
			"several-registrations",
			`"${host.name}" offers "${form.name}" on its case list, but "${form.name}" registers more than one "${caseType}" case, and CommCare HQ offers a form from a case list only where it registers one. You can move the other "${caseType}" case into a repeat or to another form, or stop offering "${form.name}" there.`,
			{ operationUuid: secondCreate },
		);
	const offeredOnNoMenu = doc.moduleOrder.find(
		(moduleUuid) =>
			afterEmptySearchRegistrationFormOf(doc, moduleUuid) === formUuid,
	);
	if (offeredOnNoMenu !== undefined) {
		const menuName = doc.modules[offeredOnNoMenu]?.name ?? "";
		return refuse(
			"after-empty-search-form",
			`"${host.name}" offers "${form.name}" on its case list, but "${form.name}" opens only after a search finds nothing in "${menuName}", so it is on no menu to offer from. You can choose a registration form that is on a menu, or stop offering it there.`,
			{ formModuleName: menuName },
		);
	}
	return undefined;
}

function alwaysFindings(
	doc: BlueprintDoc,
	host: Module,
	hostUuid: Uuid,
	formUuid: Uuid,
	afterSubmit: "case-list" | "new-case",
): ValidationError[] {
	const loc = { moduleUuid: hostUuid, moduleName: host.name };
	const form = doc.forms[formUuid];
	const formModuleUuid = moduleUuidOfForm(doc, formUuid);
	if (form === undefined || formModuleUuid === undefined)
		return [
			validationError(
				"CASE_LIST_REGISTRATION_FORM_NOT_FOUND",
				"module",
				`"${host.name}" offers a registration form on its case list, but that form is no longer in the app. You can choose another registration form, or stop offering one (register_from_case_list null).`,
				loc,
				{ formUuid, kind: "always" },
			),
		];
	const details = { formUuid, formName: form.name, kind: "always" };
	const errors: ValidationError[] = [];
	const notRegistration = alwaysNotRegistration(
		doc,
		host,
		hostUuid,
		formUuid,
		formModuleUuid,
	);
	if (notRegistration !== undefined) errors.push(notRegistration);

	if (host.caseType === undefined) {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST",
				"module",
				`"${host.name}" offers "${form.name}" on its case list, but "${host.name}" has no case type, so it has no case list to offer it from. You can set its case type, or stop offering "${form.name}" there.`,
				loc,
				{ ...details, reason: "no-case-type" },
			),
		);
	} else {
		const blockingFormUuid = menuFormUuidsOf(doc, hostUuid).find((uuid) => {
			const type = doc.forms[uuid]?.type;
			return type === undefined || !CASE_LOADING_FORM_TYPES.has(type);
		});
		if (blockingFormUuid !== undefined) {
			const blockingFormName = doc.forms[blockingFormUuid]?.name ?? "";
			errors.push(
				validationError(
					"CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST",
					"module",
					`"${host.name}" offers "${form.name}" on its case list, but "${blockingFormName}" in "${host.name}" opens without a case, and CommCare HQ offers registration from a case list only where every form of the menu opens a case. You can move "${blockingFormName}" to another menu, or stop offering "${form.name}" on the list.`,
					loc,
					{
						...details,
						reason: "form-opens-without-a-case",
						blockingFormUuid,
						blockingFormName,
					},
				),
			);
		}
	}

	if (moduleShowsFormsInMenuAbove(host)) {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE",
				"module",
				`"${host.name}" shows its forms in the menu above, and CommCare offers no Register on the case list of such a menu, so "${form.name}" would never be offered. You can give "${host.name}" its own screen again (forms_in_menu_above null), or stop offering "${form.name}" there.`,
				loc,
				{ ...details, reason: "host" },
			),
		);
	} else {
		const shared = caseListReturnSharesFirstMenuCase(doc, hostUuid);
		if (shared !== undefined) {
			const parentName = doc.modules[shared.aboveModuleUuid]?.name ?? "";
			errors.push(
				validationError(
					"CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE",
					"module",
					`"${host.name}" is under "${parentName}", which shows its forms on the app's first menu, where every form listed that way opens one chosen case. CommCare HQ would put that case ahead of "${host.name}" when a worker returns from "${form.name}". You can give "${parentName}" its own screen again (forms_in_menu_above null), or stop offering "${form.name}" there.`,
					loc,
					{
						...details,
						reason: "parent-shares-first-menu-case",
						aboveModuleUuid: shared.aboveModuleUuid,
						aboveModuleName: parentName,
					},
				),
			);
		}
	}

	if (
		caseSelectionCardinality(host) === "multiple" &&
		afterSubmit === "new-case"
	) {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_MULTIPLE_RETURN",
				"module",
				`"${form.name}" registers one case, but "${host.name}" selects several cases, and CommCare can't carry that one new case into a selection of several. You can set After registering to Back to this list (after_submit "case-list"), or let "${host.name}" select one case.`,
				loc,
				details,
			),
		);
	}

	if (emittedModuleKind(doc, hostUuid) === "advanced") {
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_ADVANCED_MENU",
				"module",
				`"${host.name}" is kept in CommCare HQ as an advanced menu, and Nova doesn't offer registration from an advanced menu's case list. You can stop offering "${form.name}" there.`,
				loc,
				{ ...details, reason: "host" },
			),
		);
	} else if (emittedModuleKind(doc, formModuleUuid) === "advanced") {
		const formModuleName = doc.modules[formModuleUuid]?.name ?? "";
		errors.push(
			validationError(
				"CASE_LIST_REGISTRATION_ADVANCED_MENU",
				"module",
				`"${form.name}" is in "${formModuleName}", which CommCare HQ keeps as an advanced menu, and Nova doesn't offer a form of an advanced menu from a case list. You can choose a registration form in another menu, or stop offering it there.`,
				loc,
				{ ...details, reason: "form", formModuleName },
			),
		);
	}
	return errors;
}
