/**
 * The four refusals behind a module that opens on Search
 * (`caseSearchConfig.searchFirst`), which lowers to CommCare's inline
 * search: the search runs inside every case-loading entry, the browse list
 * goes away, and the results instance is named `results:inline`.
 *
 *   - `SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE`: the module opens on Search
 *     only when its first screen selects a case, so every form must work on
 *     an existing case, or the module is a case list with no forms.
 *   - `SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION`: the inline shape has no
 *     Search button on a list, so a condition on that button has nowhere
 *     to land.
 *   - `SEARCH_FIRST_NO_PREVIOUS_WORKFLOW`: CommCare HQ refuses to build
 *     "previous" after submit for a case-loading form of an inline module
 *     (`helpers/validators.py`, `workflow previous inline search`), so the
 *     stored slot may not say it. The default is already the module.
 *   - `SEARCH_FIRST_UNIQUE_INSTANCE`: CommCare HQ names every module's
 *     results instance `results:inline` and refuses two of them on one
 *     session (`non-unique instance name with parent module` /
 *     `... with parent select module`). Every module Nova uploads carries a
 *     search config, so a search-first module can have no submenus, and no
 *     module may select its parent from a search-first module.
 */

import {
	type BlueprintDoc,
	childModuleUuids,
	effectiveCaseSearchConfig,
	isCaseFirstModule,
	type Module,
	moduleOpensOnSearch,
	moduleParent,
	type Uuid,
} from "@/lib/domain";
import {
	formLinkProjectionContext,
	parentSelectModuleUuid,
} from "../../../formLinkProjection";
import { type ValidationError, validationError } from "../../errors";

export function searchFirstRequiresCaseFirstModule(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	if (!moduleOpensOnSearch(mod)) return [];
	const formTypes = (doc.formOrder[moduleUuid] ?? []).flatMap((uuid) => {
		const form = doc.forms[uuid];
		return form === undefined ? [] : [form.type];
	});
	const hasCaseType = mod.caseType !== undefined && mod.caseType !== "";
	if (mod.caseListOnly === true && hasCaseType) return [];
	if (isCaseFirstModule(formTypes, hasCaseType)) return [];
	return [
		validationError(
			"SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE",
			"module",
			`Module "${mod.name}" is set to open on Search, but its first screen is not a case selection: it needs a case type and only forms that work on an existing case (or no forms, as a case list). Move its registration or survey forms to another module, or turn Search first off.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

export function searchFirstNoButtonDisplayCondition(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = effectiveCaseSearchConfig(mod);
	if (config?.searchFirst !== true) return [];
	if (config.searchButtonDisplayCondition === undefined) return [];
	return [
		validationError(
			"SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION",
			"module",
			`Module "${mod.name}" opens on Search, so it has no Search button for its button condition to show or hide. Clear the condition, or turn Search first off to get the list with a Search button back.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

export function searchFirstNoPreviousWorkflow(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	if (!moduleOpensOnSearch(mod)) return [];
	const errors: ValidationError[] = [];
	for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
		const form = doc.forms[formUuid];
		if (form === undefined || form.postSubmit !== "previous") continue;
		if (form.type !== "followup" && form.type !== "close") continue;
		errors.push(
			validationError(
				"SEARCH_FIRST_NO_PREVIOUS_WORKFLOW",
				"form",
				`Form "${form.name}" in module "${mod.name}" returns to the previous screen after submit, but CommCare cannot do that in a module that opens on Search. Send it to the module (the worker searches again) or to the app home instead.`,
				{
					moduleUuid,
					moduleName: mod.name,
					formUuid: formUuid as Uuid,
					formName: form.name,
				},
			),
		);
	}
	return errors;
}

export function searchFirstUniqueInstance(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const parentUuid = moduleParent(doc, moduleUuid);
	const parent =
		parentUuid === undefined || parentUuid === null
			? undefined
			: doc.modules[parentUuid];
	if (parent !== undefined && moduleOpensOnSearch(parent)) {
		errors.push(
			validationError(
				"SEARCH_FIRST_UNIQUE_INSTANCE",
				"module",
				`Module "${mod.name}" is a submenu under "${parent.name}", which opens on Search. CommCare gives both modules the same search results and cannot tell them apart. Move "${mod.name}" to the top level, or turn Search first off on "${parent.name}".`,
				{ moduleUuid, moduleName: mod.name },
				{ parentModuleUuid: parentUuid as string },
			),
		);
	}
	if (
		moduleOpensOnSearch(mod) &&
		childModuleUuids(doc, moduleUuid).length > 0
	) {
		// Reported on the root too, so turning Search first on with existing
		// submenus is refused at the module the author is editing.
		errors.push(
			validationError(
				"SEARCH_FIRST_UNIQUE_INSTANCE",
				"module",
				`Module "${mod.name}" opens on Search and has submenus. CommCare gives a submenu the same search results as its parent and cannot tell them apart. Move the submenus to the top level, or turn Search first off.`,
				{ moduleUuid, moduleName: mod.name },
			),
		);
	}
	const selectsFrom = parentSelectModuleUuid(
		doc,
		formLinkProjectionContext(doc),
		moduleUuid,
	);
	const selectsFromModule =
		selectsFrom === undefined ? undefined : doc.modules[selectsFrom];
	if (
		selectsFromModule !== undefined &&
		moduleOpensOnSearch(selectsFromModule)
	) {
		errors.push(
			validationError(
				"SEARCH_FIRST_UNIQUE_INSTANCE",
				"module",
				`Module "${mod.name}" selects a parent case from "${selectsFromModule.name}" first, and "${selectsFromModule.name}" opens on Search. CommCare gives both selections the same search results and cannot tell them apart. Turn Search first off on "${selectsFromModule.name}", or change the case types so "${mod.name}" no longer selects its parent there.`,
				{ moduleUuid, moduleName: mod.name },
				{ parentSelectModuleUuid: selectsFrom as string },
			),
		);
	}
	return errors;
}
