/**
 * The refusals behind a menu whose forms read the search
 * (`caseSearchConfig.formsReadSearch`), which lowers to CommCare's inline
 * search: the search runs inside every case-loading entry, the browse list
 * goes away, and the results instance is named `results:inline`.
 *
 *   - `FORMS_READ_SEARCH_REQUIRES_CASE_FIRST_MODULE`: the search runs as each
 *     case form opens only when the menu's first screen selects a case, so
 *     every menu form must work on an existing case, or the menu is a case
 *     list with no forms.
 *   - `FORMS_READ_SEARCH_NO_BUTTON_DISPLAY_CONDITION`: the inline shape has
 *     no Search button on a list, so a condition on that button has nowhere
 *     to land.
 *   - `FORMS_READ_SEARCH_UNIQUE_INSTANCE`: CommCare HQ names every module's
 *     results instance `results:inline` and refuses two of them on one
 *     session (`non-unique instance name with parent module` /
 *     `... with parent select module`). Every module Nova uploads carries a
 *     search config, so a menu whose forms read the search can have no
 *     submenus, and no module may select its parent from such a menu.
 *   - `FORMS_READ_SEARCH_WITH_LIST_FIRST`: inline search needs
 *     `auto_launch` (`app_manager/util.py::module_uses_inline_search`), which
 *     a menu that opens on its case list first does not send, so the two
 *     settings cannot stand together.
 *
 * A case-loading form of such a menu is not offered "previous" after
 * submit, since HQ refuses to build it (`helpers/validators.py`,
 * `workflow previous inline search`); Nova withholds it from every form of
 * the menu, one reason of `POST_SUBMIT_NOT_OFFERED`
 * (`rules/form.ts::postSubmitValidation`). A menu that searches first
 * without its forms reading the search sends no inline instance, so none
 * of these rules reads its workflow.
 */

import {
	type BlueprintDoc,
	childModuleUuids,
	effectiveCaseSearchConfig,
	type Module,
	moduleFormsReadSearch,
	moduleIsBareCaseList,
	moduleIsCaseFirst,
	moduleParent,
	type Uuid,
} from "@/lib/domain";
import { parentSelectModuleUuid } from "../../../formLinkProjection";
import { type ValidationError, validationError } from "../../errors";

export function formsReadSearchRequiresCaseFirstModule(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	if (!moduleFormsReadSearch(mod)) return [];
	const hasCaseType = mod.caseType !== undefined && mod.caseType !== "";
	if (moduleIsBareCaseList(doc, moduleUuid) && hasCaseType) return [];
	if (moduleIsCaseFirst(doc, moduleUuid)) return [];
	return [
		validationError(
			"FORMS_READ_SEARCH_REQUIRES_CASE_FIRST_MODULE",
			"module",
			`Module "${mod.name}" has its forms read the search, which runs the search as each case form opens, so the menu's first screen has to choose a case, and it doesn't: the menu needs a case type and only forms that work on an existing case, or no forms at all. You can move its registration or survey forms to another menu, or turn off Forms read the search (formsReadSearch null), so the menu searches first and each form reads the case it opens.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

export function formsReadSearchNoButtonDisplayCondition(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = effectiveCaseSearchConfig(mod);
	if (config?.formsReadSearch !== true) return [];
	if (config.searchButtonDisplayCondition === undefined) return [];
	return [
		validationError(
			"FORMS_READ_SEARCH_NO_BUTTON_DISPLAY_CONDITION",
			"module",
			`Module "${mod.name}" has its forms read the search, so it has no Search button for its button condition to show or hide. You can clear the condition, or turn off Forms read the search (formsReadSearch null) to bring the Search button back.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

export function formsReadSearchUniqueInstance(
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
	if (parent !== undefined && moduleFormsReadSearch(parent)) {
		errors.push(
			validationError(
				"FORMS_READ_SEARCH_UNIQUE_INSTANCE",
				"module",
				`Module "${mod.name}" is a submenu under "${parent.name}", whose forms read the search. CommCare gives both menus the same search results and can't tell them apart. You can move "${mod.name}" to the top level, or turn off Forms read the search on "${parent.name}".`,
				{ moduleUuid, moduleName: mod.name },
				{ parentModuleUuid: parentUuid as string },
			),
		);
	}
	if (
		moduleFormsReadSearch(mod) &&
		childModuleUuids(doc, moduleUuid).length > 0
	) {
		// Reported on the root too, so turning Forms read the search on with
		// existing submenus is refused at the module the author is editing.
		errors.push(
			validationError(
				"FORMS_READ_SEARCH_UNIQUE_INSTANCE",
				"module",
				`Module "${mod.name}" has its forms read the search and has submenus. CommCare gives a submenu the same search results as its parent and can't tell them apart. You can move the submenus to the top level, or turn off Forms read the search.`,
				{ moduleUuid, moduleName: mod.name },
			),
		);
	}
	const selectsFrom = parentSelectModuleUuid(doc, moduleUuid);
	const selectsFromModule =
		selectsFrom === undefined ? undefined : doc.modules[selectsFrom];
	if (
		selectsFromModule !== undefined &&
		moduleFormsReadSearch(selectsFromModule)
	) {
		errors.push(
			validationError(
				"FORMS_READ_SEARCH_UNIQUE_INSTANCE",
				"module",
				`Module "${mod.name}" chooses a parent case from "${selectsFromModule.name}" first, and "${selectsFromModule.name}"'s forms read the search. CommCare gives both choices the same search results and can't tell them apart. You can turn off Forms read the search on "${selectsFromModule.name}", or choose the parent case from another menu or a flat list.`,
				{ moduleUuid, moduleName: mod.name },
				{ parentSelectModuleUuid: selectsFrom as string },
			),
		);
	}
	return errors;
}

/**
 * The stored schema refuses the pair (`ordinaryCaseSearchConfigSchema`);
 * this rule refuses the batch that would reach it, a workflow patch that
 * sets list first while Forms read the search is stored, or the reverse.
 */
export function formsReadSearchWithListFirst(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = effectiveCaseSearchConfig(mod);
	if (config?.workflow !== "listFirst" || config.formsReadSearch !== true)
		return [];
	return [
		validationError(
			"FORMS_READ_SEARCH_WITH_LIST_FIRST",
			"module",
			`Module "${mod.name}" opens on its case list first, so its forms can't read the search, which runs only when the menu opens on Search first or on its results. You can choose Search first or Results first (searchWorkflow), or turn off Forms read the search (formsReadSearch null).`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}
