/**
 * Module-level validation rules.
 *
 * Each rule receives the `BlueprintDoc`, the module entity, and the module's
 * uuid so errors carry stable provenance. The runner invokes every rule on
 * every module.
 */

import { CASE_TYPE_REGEX, MAX_CASE_TYPE_LENGTH } from "@/lib/commcare";
import {
	type BlueprintDoc,
	type Module,
	menuFormUuidsOf,
	moduleHasCaseListMenuItem,
	moduleIsBareCaseList,
	type Uuid,
} from "@/lib/domain";
import { caseParentSelectionVerdict } from "@/lib/domain/caseParentSelection";
import { type ValidationError, validationError } from "../errors";
import type { LookupTypeIndex } from "../lookupTypeContext";
import { ancestorExistsCannotNestSubcase } from "./case-list/ancestorExistsCannotNestSubcase";
import { calculatedColumnTypeCheck } from "./case-list/calculatedColumnTypeCheck";
import { caseTileGrouping } from "./case-list/caseTileGrouping";
import { caseTileHiddenCalculatedSort } from "./case-list/caseTileHiddenCalculatedSort";
import { caseTileLayout } from "./case-list/caseTileLayout";
import { columnKindPropertyType } from "./case-list/columnKindPropertyType";
import { columnReferences } from "./case-list/columnReferences";
import { csqlPredicateRepresentability } from "./case-list/csqlPredicateRepresentability";
import { dateAddOnDeviceCompatibility } from "./case-list/dateAddOnDeviceCompatibility";
import { dateColumnPattern } from "./case-list/dateColumnPattern";
import { filterTypeCheck } from "./case-list/filterTypeCheck";
import { idMappingKeyCharacters } from "./case-list/idMappingKeyCharacters";
import { matchModeOnDeviceCompatibility } from "./case-list/matchModeOnDeviceCompatibility";
import { matchModeWhitespaceInValue } from "./case-list/matchModeWhitespaceInValue";
import { onDeviceExpressionCompatibility } from "./case-list/onDeviceExpressionCompatibility";
import { searchInputDefaultTypeCheck } from "./case-list/searchInputDefaultTypeCheck";
import { searchInputModeMatchesPropertyType } from "./case-list/searchInputModeMatchesPropertyType";
import { searchInputNameUniqueness } from "./case-list/searchInputNameUniqueness";
import { searchInputPredicateTypeCheck } from "./case-list/searchInputPredicateTypeCheck";
import { searchInputRefUsesWhenInputPresent } from "./case-list/searchInputRefUsesWhenInputPresent";
import { searchInputReservedName } from "./case-list/searchInputReservedName";
import { searchInputScreenPredicateTypeCheck } from "./case-list/searchInputScreenPredicateTypeCheck";
import { searchInputTypeMatchesPropertyType } from "./case-list/searchInputTypeMatchesPropertyType";
import { searchInputViaModeCompatibility } from "./case-list/searchInputViaModeCompatibility";
import { sortPriorityUniqueness } from "./case-list/sortPriorityUniqueness";
import { sortPropertyOwnership } from "./case-list/sortPropertyOwnership";
import { caseListRegistrationForm } from "./case-search/caseListRegistration";
import { caseSearchConfigRequiresCaseType } from "./case-search/caseSearchConfigRequiresCaseType";
import { excludedOwnerIdsTypeCheck } from "./case-search/excludedOwnerIdsTypeCheck";
import {
	formsReadSearchNoButtonDisplayCondition,
	formsReadSearchRequiresCaseFirstModule,
	formsReadSearchUniqueInstance,
	formsReadSearchWithListFirst,
} from "./case-search/formsReadSearch";
import { searchButtonDisplayConditionTypeCheck } from "./case-search/searchButtonDisplayConditionTypeCheck";
import { searchRelatedCalculationCompatibility } from "./case-search/searchRelatedCalculationCompatibility";
import { heldModuleKindInexpressible } from "./casePlacement";
import { moduleDisplayCondition } from "./displayConditions";
import { hiddenMenuEntryPoints } from "./hiddenFromMenu";
import { imageMapValueUnique } from "./media/imageMapValueUnique";
import { multiSelectTopology } from "./multiSelect";

function formsOf(doc: BlueprintDoc, moduleUuid: Uuid) {
	return (doc.formOrder[moduleUuid] ?? []).map((uuid) => doc.forms[uuid]);
}

/**
 * The forms the wire lists on the module's menu. A case list registration
 * form lowers into its own hidden module, so the structural shapes CommCare
 * checks on a module (formless, a bare case list, cross-type root) see only
 * the menu forms.
 */
function menuFormsOf(doc: BlueprintDoc, moduleUuid: Uuid) {
	return menuFormUuidsOf(doc, moduleUuid).map((uuid) => doc.forms[uuid]);
}

function caseFormsNoCaseType(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = formsOf(doc, moduleUuid);
	const hasCaseForms = forms.some((f) => f.type !== "survey");
	if (!hasCaseForms || mod.caseType) return [];
	return [
		validationError(
			"NO_CASE_TYPE",
			"module",
			`Module "${mod.name}" has registration, followup, or close forms but no case_type. These form types require cases, so the module needs to know which case type to work with. Set case_type to the type of case this module manages (for example "patient" or "household").`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

function caseListMenuItemNoCaseType(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!moduleHasCaseListMenuItem(mod) || mod.caseType) return [];
	return [
		validationError(
			"CASE_LIST_MENU_ITEM_NO_CASE_TYPE",
			"module",
			`Module "${mod.name}" lists its case list as a menu entry but has no case type, so the list has no cases to show. You can set the case type it lists, or take the entry off (case_list_menu_item null).`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

function noFormsOrCaseList(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = menuFormsOf(doc, moduleUuid);
	// A module with no menu forms is valid only where its case list is a menu
	// entry of its own. Every other module, case-typed OR a plain survey
	// menu, needs at least one form: CommCare rejects a menu with no forms
	// and no case list as a HARD, build-blocking error, regardless of case
	// type (`ModuleValidator.validate_with_raise` in commcare-hq's
	// app_manager/helpers/validators.py: `if not module.forms and not
	// module.case_list.show`). A case list registration form lowers into a
	// hidden module of its own, so it is no form of this one. So the check
	// must NOT be gated on caseType: a typeless, formless menu is just as
	// invalid, and Nova would emit the exact wire CommCare then refuses to
	// build.
	if (moduleHasCaseListMenuItem(mod) || forms.length > 0) return [];
	// One finding, two contexts: creating a module without a form, and removing
	// a module's LAST form. So the wording can't just say "add a form" — that
	// reads backwards when you're deleting. It states the rule, then names the
	// resolutions for both directions (a module always keeps ≥1 form, so to drop
	// the last one you either add another first or remove the whole module).
	const message = mod.caseType
		? `Module "${mod.name}" has a case type ("${mod.caseType}") but no forms. CommCare needs forms that work with its cases or a case list entry, so you can add a form, give it a case list menu entry, or, if you're removing its last form, delete the whole menu.`
		: `Module "${mod.name}" needs at least one form. CommCare won't build a menu with no forms and no case list. Add a form, or, if you're removing its last one, add another form first or delete the whole module.`;
	return [
		validationError("NO_FORMS_OR_CASE_LIST", "module", message, {
			moduleUuid,
			moduleName: mod.name,
		}),
	];
}

/** HQ's child-module `add_parent_datums` aligns a child entry against the
 * root module's first form. A bare case list root has no such entry,
 * so a different child case type cannot receive its distinct datum identity.
 * Same-type children need no second identity and remain representable. */
function nestedMenuCrossTypeRootRequiresForm(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const parentUuid = mod.parentModuleUuid;
	if (parentUuid === undefined || parentUuid === null) return [];
	const parent = doc.modules[parentUuid];
	if (
		parent === undefined ||
		!moduleIsBareCaseList(doc, parentUuid) ||
		!parent.caseType ||
		!mod.caseType ||
		parent.caseType === mod.caseType
	) {
		return [];
	}
	return [
		validationError(
			"NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM",
			"module",
			`Module "${mod.name}" cannot be a submenu under case-list-only module "${parent.name}" because they use different case types ("${mod.caseType}" and "${parent.caseType}"). CommCare needs a form in the top-level module to keep both case selections distinct. Turn "${parent.name}" into a form-bearing module and add a form, make both modules use the same case type, or make "${mod.name}" top-level.`,
			{ moduleUuid, moduleName: mod.name },
			{
				parentModuleUuid: parentUuid,
				parentCaseType: parent.caseType,
				childCaseType: mod.caseType,
			},
		),
	];
}

function invalidCaseTypeFormat(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseType || CASE_TYPE_REGEX.test(mod.caseType)) return [];
	return [
		validationError(
			"INVALID_CASE_TYPE_FORMAT",
			"module",
			`Module "${mod.name}" has case_type "${mod.caseType}", which holds a character a case type can't. A case type holds only letters, digits, underscores and hyphens (for example "patient", "home_visit" or "1st-visit").`,
			{ moduleUuid, moduleName: mod.name },
			{ caseType: mod.caseType },
		),
	];
}

function caseTypeTooLong(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseType || mod.caseType.length <= MAX_CASE_TYPE_LENGTH) return [];
	return [
		validationError(
			"CASE_TYPE_TOO_LONG",
			"module",
			`Module "${mod.name}" has a case_type that is ${mod.caseType.length} characters long. CommCare limits case type names to ${MAX_CASE_TYPE_LENGTH} characters. Use a shorter, more descriptive name.`,
			{ moduleUuid, moduleName: mod.name },
			{ caseType: mod.caseType },
		),
	];
}

/**
 * Every reachable case list needs at least one visible Results field so a
 * person has something to scan before choosing a case. A definition that is
 * Details-only (or otherwise kept off Results) does not satisfy that floor.
 * This applies equally to form-bearing case modules and to a case list
 * menu entry: a bare case list has no other screen through which a case can be picked.
 */
function missingCaseListColumns(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const forms = menuFormsOf(doc, moduleUuid);
	const columns = mod.caseListConfig?.columns ?? [];
	const hasVisibleResult = columns.some(
		(column) => column.visibleInList !== false,
	);
	const needsColumns =
		!!mod.caseType &&
		(moduleHasCaseListMenuItem(mod) || forms.length > 0) &&
		!hasVisibleResult;
	if (!needsColumns) return [];
	return [
		validationError(
			"MISSING_CASE_LIST_COLUMNS",
			"module",
			`Module "${mod.name}" shows "${mod.caseType}" cases but its Results screen has no visible fields. Every case list needs at least one visible Results field so users can tell rows apart and pick which case to open. Add or restore an identifying field such as "case_name" on Results.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}

type ModuleRule = (
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
) => ValidationError[];

function parentCaseSelection(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	if (mod.parentCaseModuleUuid === undefined) return [];
	const verdict = caseParentSelectionVerdict(
		doc,
		moduleUuid,
		mod.parentCaseModuleUuid,
	);
	return verdict.ok
		? []
		: [
				validationError(
					"CASE_PARENT_SELECTION_INVALID",
					"module",
					verdict.message,
					{ moduleUuid, moduleName: mod.name },
				),
			];
}

/**
 * The rules that read a column's order rule. The commit gate runs them in
 * `MODULE_RULES`, and Default order's Add menu runs exactly these over the
 * list a choice would leave (`lib/doc/commitVerdicts.ts::caseListOrderChoiceRefusal`),
 * so a choice the menu offers is one the gate admits.
 */
export const CASE_LIST_ORDER_RULES: readonly ModuleRule[] = [
	sortPriorityUniqueness,
	sortPropertyOwnership,
	caseTileHiddenCalculatedSort,
];

export const MODULE_RULES: readonly ModuleRule[] = [
	parentCaseSelection,
	caseFormsNoCaseType,
	caseListMenuItemNoCaseType,
	noFormsOrCaseList,
	nestedMenuCrossTypeRootRequiresForm,
	invalidCaseTypeFormat,
	caseTypeTooLong,
	missingCaseListColumns,
	multiSelectTopology,
	heldModuleKindInexpressible,
	moduleDisplayCondition,
	hiddenMenuEntryPoints,
	// Case-list-config rules (sit at module scope; the cross-form
	// kind-vs-property-type rule lives at app scope in `app.ts`).
	columnReferences,
	columnKindPropertyType,
	filterTypeCheck,
	calculatedColumnTypeCheck,
	imageMapValueUnique,
	idMappingKeyCharacters,
	dateColumnPattern,
	matchModeWhitespaceInValue,
	matchModeOnDeviceCompatibility,
	onDeviceExpressionCompatibility,
	dateAddOnDeviceCompatibility,
	ancestorExistsCannotNestSubcase,
	...CASE_LIST_ORDER_RULES,
	caseTileLayout,
	caseTileGrouping,
	searchInputNameUniqueness,
	searchInputReservedName,
	searchInputModeMatchesPropertyType,
	searchInputTypeMatchesPropertyType,
	searchInputDefaultTypeCheck,
	searchInputPredicateTypeCheck,
	searchInputScreenPredicateTypeCheck,
	csqlPredicateRepresentability,
	searchInputRefUsesWhenInputPresent,
	searchInputViaModeCompatibility,
	// Case-search-config rules. Slot-specific checks read authored config;
	// structural/conflict checks use `effectiveCaseSearchConfig`, so legacy
	// markerless inputs receive the same validation as the remote request they
	// still emit.
	searchButtonDisplayConditionTypeCheck,
	excludedOwnerIdsTypeCheck,
	searchRelatedCalculationCompatibility,
	caseSearchConfigRequiresCaseType,
	// Forms read the search lowers to CommCare's inline search; these are
	// the shapes it cannot carry.
	formsReadSearchRequiresCaseFirstModule,
	formsReadSearchNoButtonDisplayCondition,
	formsReadSearchUniqueInstance,
	formsReadSearchWithListFirst,
	caseListRegistrationForm,
];
